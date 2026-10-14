//! Google service-account OAuth without a gcloud dependency.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::provider::VertexServiceAccount;
use crate::proxy::error::ProxyError;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CLOUD_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const MAX_KEY_JSON_BYTES: usize = 1024 * 1024;
const MAX_CACHED_ACCOUNTS: usize = 128;

fn invalid_credentials() -> ProxyError {
    ProxyError::AuthError("Invalid Vertex AI service account JSON or RSA private key".into())
}

fn validate_fields(credentials: &VertexServiceAccount) -> Result<(), ProxyError> {
    if credentials.account_type != "service_account"
        || credentials.project_id.trim().is_empty()
        || credentials.private_key_id.trim().is_empty()
        || !credentials.client_email.ends_with(".gserviceaccount.com")
        || !credentials.client_email.contains('@')
        || credentials.client_email.chars().any(char::is_whitespace)
        || credentials.private_key.len() > MAX_KEY_JSON_BYTES
        || credentials.token_uri != TOKEN_URL
    {
        return Err(invalid_credentials());
    }
    Ok(())
}

pub fn import_service_account(json: &str) -> Result<VertexServiceAccount, ProxyError> {
    if json.len() > MAX_KEY_JSON_BYTES {
        return Err(invalid_credentials());
    }
    // Never include serde or crypto errors, which can contain credential material.
    let credentials: VertexServiceAccount =
        serde_json::from_str(json).map_err(|_| invalid_credentials())?;
    validate_fields(&credentials)?;
    // Signing validates RSA key material, not just the PEM envelope.
    assertion(&credentials)?;
    Ok(credentials)
}

#[derive(Serialize, Deserialize)]
struct Claims {
    iss: String,
    scope: String,
    aud: String,
    iat: i64,
    exp: i64,
}

fn assertion(credentials: &VertexServiceAccount) -> Result<String, ProxyError> {
    validate_fields(credentials)?;
    let key = EncodingKey::from_rsa_pem(credentials.private_key.as_bytes())
        .map_err(|_| invalid_credentials())?;
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: credentials.client_email.clone(),
        scope: CLOUD_SCOPE.into(),
        aud: TOKEN_URL.into(),
        iat: now,
        exp: now + 3600,
    };
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(credentials.private_key_id.clone());
    encode(&header, &claims, &key).map_err(|_| invalid_credentials())
}

struct CachedToken {
    token: String,
    refresh_at: Instant,
}

type TokenCache = Mutex<HashMap<[u8; 32], CachedToken>>;
static TOKENS: Lazy<TokenCache> = Lazy::new(|| Mutex::new(HashMap::new()));

fn fingerprint(credentials: &VertexServiceAccount) -> [u8; 32] {
    let mut digest = Sha256::new();
    for field in [
        &credentials.client_email,
        &credentials.private_key_id,
        &credentials.private_key,
    ] {
        digest.update(field.as_bytes());
        digest.update([0]);
    }
    digest.finalize().into()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    token_type: String,
}

pub async fn access_token(credentials: &VertexServiceAccount) -> Result<String, ProxyError> {
    token_with_client(
        credentials,
        &crate::proxy::http_client::get(),
        TOKEN_URL,
        &TOKENS,
    )
    .await
}

// The endpoint and cache are injectable for local tests; production always uses Google's endpoint.
async fn token_with_client(
    credentials: &VertexServiceAccount,
    client: &reqwest::Client,
    endpoint: &str,
    cache: &TokenCache,
) -> Result<String, ProxyError> {
    validate_fields(credentials)?;
    let fingerprint = fingerprint(credentials);
    let mut cache = cache.lock().await;
    if let Some(cached) = cache
        .get(&fingerprint)
        .filter(|cached| cached.refresh_at > Instant::now())
    {
        return Ok(cached.token.clone());
    }
    let jwt = assertion(credentials)?;
    let response = client
        .post(endpoint)
        .timeout(Duration::from_secs(15))
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", jwt.as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            ProxyError::AuthError("Vertex AI service account token request failed".into())
        })?;
    if !response.status().is_success() {
        // Do not surface the body, assertion, response headers, or private key in logs/errors.
        return Err(ProxyError::AuthError(format!(
            "Vertex AI service account token request failed (HTTP {})",
            response.status().as_u16()
        )));
    }
    let token: TokenResponse = response.json().await.map_err(|_| {
        ProxyError::AuthError("Invalid Vertex AI service account token response".into())
    })?;
    if !token.token_type.eq_ignore_ascii_case("Bearer") || token.expires_in == 0 {
        return Err(ProxyError::AuthError(
            "Invalid Vertex AI service account token response".into(),
        ));
    }
    super::adapter::auth_header_value(&format!("Bearer {}", token.access_token)).map_err(|_| {
        ProxyError::AuthError("Invalid Vertex AI service account access token".into())
    })?;
    if token.access_token.trim().is_empty() {
        return Err(ProxyError::AuthError(
            "Invalid Vertex AI service account access token".into(),
        ));
    }
    // Refresh before expiry; clamp anomalous TTLs and retain only useful entries.
    let lifetime = token.expires_in.min(3600);
    let refresh_after = lifetime - 60.min(lifetime / 2);
    cache.retain(|_, cached| cached.refresh_at > Instant::now());
    if cache.len() >= MAX_CACHED_ACCOUNTS {
        cache.clear();
    }
    cache.insert(
        fingerprint,
        CachedToken {
            token: token.access_token.clone(),
            refresh_at: Instant::now() + Duration::from_secs(refresh_after),
        },
    );
    Ok(token.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, http::StatusCode, routing::post, Router};
    use jsonwebtoken::{decode, DecodingKey, Validation};
    use serde_json::{json, Value};
    use std::sync::Arc;

    // Generated solely for tests; this key has never belonged to a Google account.
    const TEST_KEY: &str = include_str!("testdata/vertex-test-key.pem");
    const TEST_PUBLIC_KEY: &str = include_str!("testdata/vertex-test-public.pem");

    fn credentials() -> VertexServiceAccount {
        VertexServiceAccount {
            account_type: "service_account".into(),
            project_id: "test-project".into(),
            private_key_id: "test-key-id".into(),
            private_key: TEST_KEY.into(),
            client_email: "test@test-project.iam.gserviceaccount.com".into(),
            token_uri: TOKEN_URL.into(),
        }
    }

    fn verify_assertion(jwt: &str) -> jsonwebtoken::TokenData<Claims> {
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[TOKEN_URL]);
        decode::<Claims>(
            jwt,
            &DecodingKey::from_rsa_pem(TEST_PUBLIC_KEY.as_bytes()).unwrap(),
            &validation,
        )
        .unwrap()
    }

    #[test]
    fn vertex_service_account_import_validates_and_signs_google_oauth_assertion() {
        let mut json = serde_json::to_value(credentials()).unwrap();
        json["client_id"] = json!("unused");
        let imported = import_service_account(&json.to_string()).unwrap();
        let jwt = verify_assertion(&assertion(&imported).unwrap());
        assert_eq!(jwt.header.kid.as_deref(), Some("test-key-id"));
        assert_eq!(jwt.claims.iss, imported.client_email);
        assert_eq!(jwt.claims.scope, CLOUD_SCOPE);
        assert_eq!(jwt.claims.exp - jwt.claims.iat, 3600);
        assert!(!format!("{imported:?}").contains(TEST_KEY));
        let serialized = serde_json::to_value(&imported).unwrap();
        assert_eq!(serialized["private_key"], TEST_KEY);
        assert!(serialized.get("client_id").is_none());
        let legacy: crate::provider::VertexAiConfig =
            serde_json::from_value(json!({"projectId": "project", "location": "global"})).unwrap();
        assert!(legacy.service_account.is_none());
    }

    #[test]
    fn vertex_service_account_rejects_invalid_keys_and_untrusted_token_endpoints() {
        for (field, bad) in [
            ("type", "authorized_user"),
            ("private_key", "SECRET-invalid-pem"),
            ("client_email", "bad@example.com"),
            ("token_uri", "https://attacker.example/token"),
            ("token_uri", "http://oauth2.googleapis.com/token"),
            ("private_key_id", ""),
        ] {
            let mut data = serde_json::to_value(credentials()).unwrap();
            data[field] = json!(bad);
            let error = import_service_account(&data.to_string())
                .unwrap_err()
                .to_string();
            assert!(bad.is_empty() || !error.contains(bad));
            assert!(!error.contains(TEST_KEY));
        }
        assert!(import_service_account("{invalid-json}").is_err());
        assert!(import_service_account(&" ".repeat(MAX_KEY_JSON_BYTES + 1)).is_err());
        let mut data = serde_json::to_value(credentials()).unwrap();
        data.as_object_mut().unwrap().remove("private_key");
        assert!(import_service_account(&data.to_string()).is_err());
    }

    #[tokio::test]
    async fn vertex_service_account_invalid_key_does_not_fall_back_to_static_token_or_gcloud() {
        let mut credentials = credentials();
        credentials.private_key = "bad-key".into();
        assert!(
            super::super::vertex::auth_headers(Some("old-static-token"), Some(&credentials))
                .await
                .is_err()
        );
    }

    async fn mock_endpoint(
        status: StatusCode,
        body: Value,
        requests: Arc<Mutex<Vec<Claims>>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/token",
            post(move |bytes: Bytes| {
                let body = body.clone();
                let requests = requests.clone();
                async move {
                    let form: HashMap<String, String> =
                        url::form_urlencoded::parse(&bytes).into_owned().collect();
                    assert_eq!(
                        form["grant_type"],
                        "urn:ietf:params:oauth:grant-type:jwt-bearer"
                    );
                    let jwt = verify_assertion(&form["assertion"]);
                    requests.lock().await.push(jwt.claims);
                    (status, axum::Json(body))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (endpoint, task)
    }

    #[tokio::test]
    async fn vertex_service_account_tokens_refresh_and_isolate_accounts_and_key_rotation() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (endpoint, task) = mock_endpoint(StatusCode::OK, json!({"access_token": "test-access-token", "expires_in": 3600, "token_type": "Bearer"}), requests.clone()).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let cache = Mutex::new(HashMap::new());
        let credentials = credentials();
        assert_eq!(
            token_with_client(&credentials, &client, &endpoint, &cache)
                .await
                .unwrap(),
            "test-access-token"
        );
        token_with_client(&credentials, &client, &endpoint, &cache)
            .await
            .unwrap();
        assert_eq!(requests.lock().await.len(), 1);
        cache
            .lock()
            .await
            .get_mut(&fingerprint(&credentials))
            .unwrap()
            .refresh_at = Instant::now();
        token_with_client(&credentials, &client, &endpoint, &cache)
            .await
            .unwrap();
        let mut rotated = credentials.clone();
        rotated.private_key_id = "rotated-key-id".into();
        token_with_client(&rotated, &client, &endpoint, &cache)
            .await
            .unwrap();
        let mut other_account = credentials.clone();
        other_account.client_email = "other@test-project.iam.gserviceaccount.com".into();
        token_with_client(&other_account, &client, &endpoint, &cache)
            .await
            .unwrap();
        assert_eq!(requests.lock().await.len(), 4);
        assert_eq!(requests.lock().await[3].iss, other_account.client_email);
        // A private key change must also invalidate the cache even if its id stays the same.
        let mut changed_material = credentials.clone();
        changed_material.private_key.push('\n');
        token_with_client(&changed_material, &client, &endpoint, &cache)
            .await
            .unwrap();
        assert_eq!(requests.lock().await.len(), 5);
        task.abort();
    }

    #[tokio::test]
    async fn vertex_service_account_oauth_failures_are_sanitized_and_never_cached() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let credentials = credentials();
        for (status, body) in [
            (
                StatusCode::BAD_REQUEST,
                json!({"error_description": TEST_KEY}),
            ),
            (
                StatusCode::OK,
                json!({"access_token": "secret-token", "expires_in": 0, "token_type": "Bearer"}),
            ),
            (
                StatusCode::OK,
                json!({"access_token": "secret-token", "expires_in": 3600, "token_type": "unknown"}),
            ),
            (
                StatusCode::OK,
                json!({"access_token": "secret-token\r\nleak", "expires_in": 3600, "token_type": "Bearer"}),
            ),
            (
                StatusCode::OK,
                json!({"access_token": "", "expires_in": 3600, "token_type": "Bearer"}),
            ),
        ] {
            let (endpoint, task) =
                mock_endpoint(status, body, Arc::new(Mutex::new(Vec::new()))).await;
            let cache = Mutex::new(HashMap::new());
            let error = token_with_client(&credentials, &client, &endpoint, &cache)
                .await
                .unwrap_err()
                .to_string();
            assert!(!error.contains(TEST_KEY));
            assert!(!error.contains("secret-token"));
            assert!(cache.lock().await.is_empty());
            task.abort();
        }
    }
}
