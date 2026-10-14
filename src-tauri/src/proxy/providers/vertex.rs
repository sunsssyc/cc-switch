//! Vertex AI transports for Claude and Gemini, sharing Google ADC authentication.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::sync::Mutex;

use super::adapter::auth_header_value;
use crate::provider::{Provider, VertexAiConfig, VertexServiceAccount};
use crate::proxy::error::ProxyError;

pub fn is_vertex_provider(provider: &Provider) -> bool {
    provider
        .meta
        .as_ref()
        .and_then(|m| m.vertex_ai.as_ref())
        .is_some()
        || provider
            .settings_config
            .pointer("/env/CLAUDE_CODE_USE_VERTEX")
            .and_then(Value::as_str)
            .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

pub fn config(provider: &Provider) -> Option<VertexAiConfig> {
    if let Some(config) = provider.meta.as_ref().and_then(|m| m.vertex_ai.clone()) {
        return Some(config);
    }
    if !is_vertex_provider(provider) {
        return None;
    }
    Some(VertexAiConfig {
        project_id: env_string(provider, "ANTHROPIC_VERTEX_PROJECT_ID")
            .unwrap_or("")
            .into(),
        location: env_string(provider, "CLOUD_ML_REGION")
            .unwrap_or("us-east5")
            .into(),
        publisher: None,
        service_account: None,
    })
}

/// Legacy fixed-publisher rows keep their transport; unified rows resolve each model.
pub fn is_gemini_request(provider: &Provider, model: Option<&str>) -> bool {
    match provider
        .meta
        .as_ref()
        .and_then(|m| m.vertex_ai.as_ref())
        .and_then(|config| config.publisher.as_deref())
    {
        Some("google") => true,
        Some("auto") => model.is_some_and(|model| model.trim().starts_with("gemini-")),
        _ => false,
    }
}

pub fn is_gemini_provider(provider: &Provider) -> bool {
    let codex_model = super::codex::codex_provider_upstream_model(provider);
    is_gemini_request(
        provider,
        env_string(provider, "ANTHROPIC_MODEL").or(codex_model.as_deref()),
    )
}

fn env_string<'a>(provider: &'a Provider, key: &str) -> Option<&'a str> {
    provider
        .settings_config
        .get("env")?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn valid_segment(value: &str, allow_model_version: bool) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || b == b'-'
                || b == b'_'
                || (allow_model_version && b == b'@')
        })
}

fn endpoint_base_url(provider: &Provider, location: &str) -> String {
    let host = match location {
        "global" => "aiplatform.googleapis.com".to_string(),
        "us" | "eu" => format!("aiplatform.{location}.rep.googleapis.com"),
        _ => format!("{location}-aiplatform.googleapis.com"),
    };
    env_string(provider, "ANTHROPIC_VERTEX_BASE_URL")
        .map(|base| {
            base.trim_end_matches('/')
                .trim_end_matches("/v1")
                .to_string()
        })
        .unwrap_or_else(|| format!("https://{host}"))
}

/// Shared with adapter-based reachability checks; no model call or auth required.
pub fn base_url(provider: &Provider) -> Result<String, ProxyError> {
    let config = config(provider)
        .ok_or_else(|| ProxyError::ConfigError("Missing Vertex AI configuration".into()))?;
    if !valid_segment(config.location.trim(), false) {
        return Err(ProxyError::ConfigError("Invalid Vertex AI location".into()));
    }
    Ok(endpoint_base_url(provider, config.location.trim()))
}

/// Match the Anthropic Vertex SDK, including global and multi-region hosts.
pub fn prepare_request(
    config: &VertexAiConfig,
    provider: &Provider,
    endpoint: &str,
    body: &mut Value,
) -> Result<String, ProxyError> {
    let project = config.project_id.trim();
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| ProxyError::InvalidRequest("Vertex AI requires a model".into()))?
        .trim_end_matches("[1m]")
        .to_string();
    let region_key = match model.as_str() {
        "claude-haiku-4-5@20251001" => Some("VERTEX_REGION_CLAUDE_HAIKU_4_5"),
        _ => None,
    };
    let location = region_key
        .and_then(|key| env_string(provider, key))
        .unwrap_or(config.location.trim());
    if !valid_segment(project, false) || !valid_segment(location, false) {
        return Err(ProxyError::ConfigError(
            "Vertex AI requires a valid project ID and location".into(),
        ));
    }
    if !valid_segment(&model, true) {
        return Err(ProxyError::InvalidRequest(
            "Invalid Vertex AI model ID".into(),
        ));
    }
    let base = endpoint_base_url(provider, location);
    let path = endpoint.split('?').next().unwrap_or(endpoint);
    let action = match path {
        "/v1/messages" | "/messages" => {
            body.as_object_mut().unwrap().remove("model");
            if body.get("stream").and_then(Value::as_bool) == Some(true) {
                format!("{model}:streamRawPredict")
            } else {
                format!("{model}:rawPredict")
            }
        }
        "/v1/messages/count_tokens" | "/messages/count_tokens" => {
            body["model"] = Value::String(model);
            "count-tokens:rawPredict".into()
        }
        _ => {
            return Err(ProxyError::InvalidRequest(format!(
                "Unsupported Vertex AI endpoint: {path}"
            )))
        }
    };
    body["anthropic_version"] = Value::String("vertex-2023-10-16".into());
    Ok(format!(
        "{base}/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{action}"
    ))
}

/// Gemini generateContent uses the model in the URL and has no Anthropic envelope.
pub fn prepare_gemini_request(
    config: &VertexAiConfig,
    provider: &Provider,
    model: &str,
    stream: bool,
    body: &mut Value,
) -> Result<String, ProxyError> {
    let project = config.project_id.trim();
    let location = config.location.trim();
    let model = model.trim_end_matches("[1m]");
    // Decimal model versions (for example Gemini 3.8) are valid path IDs.
    // Validate each component so empty or traversal-only segments stay invalid.
    if !valid_segment(project, false)
        || !model
            .split('.')
            .all(|segment| valid_segment(segment, false))
    {
        return Err(ProxyError::ConfigError(
            "Vertex AI Gemini requires a valid project and model ID".into(),
        ));
    }
    if !matches!(location, "global" | "us" | "eu") {
        return Err(ProxyError::ConfigError(
            "Gemini 3.8+ requires location global, us or eu".into(),
        ));
    }
    if model.starts_with("gemini-4") {
        body.as_object_mut()
            .ok_or_else(|| ProxyError::InvalidRequest("Gemini request must be an object".into()))?
            .remove("cachedContent");
        // Gemini 4 does not accept an assistant prefill at the end of the prompt.
        if let Some(contents) = body.get_mut("contents").and_then(Value::as_array_mut) {
            if contents
                .last()
                .and_then(|turn| turn.get("role"))
                .and_then(Value::as_str)
                == Some("model")
            {
                contents.pop();
            }
        }
    }
    let generation = body
        .as_object_mut()
        .ok_or_else(|| ProxyError::InvalidRequest("Gemini request must be an object".into()))?
        .entry("generationConfig")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(generation) = generation.as_object_mut() {
        if model.starts_with("gemini-4") {
            for key in [
                "temperature",
                "topP",
                "topK",
                "candidateCount",
                "frequencyPenalty",
                "presencePenalty",
            ] {
                generation.remove(key);
            }
        }
        let ceiling = if model.starts_with("gemini-4") && !stream {
            32768
        } else {
            65536
        };
        if let Some(max) = generation.get("maxOutputTokens").and_then(Value::as_u64) {
            generation.insert("maxOutputTokens".into(), Value::from(max.min(ceiling)));
        }
        if let Some(thinking) = generation
            .get_mut("thinkingConfig")
            .and_then(Value::as_object_mut)
        {
            thinking.remove("thinkingBudget");
            let level = thinking
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .unwrap_or("MEDIUM")
                .to_ascii_uppercase();
            let level = if matches!(level.as_str(), "LOW" | "MEDIUM" | "HIGH") {
                level
            } else {
                "LOW".into()
            };
            thinking.insert("thinkingLevel".into(), Value::String(level));
        }
    }
    let action = if stream {
        "streamGenerateContent?alt=sse"
    } else {
        "generateContent"
    };
    Ok(format!(
        "{}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:{action}",
        endpoint_base_url(provider, location)
    ))
}

// Cache only ADC output; user-provided tokens are read from the row every time.
// A short cache also picks up external gcloud credential changes promptly.
static ADC_TOKEN: Lazy<Mutex<Option<(String, Instant)>>> = Lazy::new(|| Mutex::new(None));

fn gcloud_path() -> PathBuf {
    let name = if cfg!(windows) {
        "gcloud.cmd"
    } else {
        "gcloud"
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("google-cloud-sdk/bin"));
    }
    dirs.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/local/google-cloud-sdk/bin",
        ]
        .map(PathBuf::from),
    );
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

pub async fn auth_headers(
    explicit_token: Option<&str>,
    service_account: Option<&VertexServiceAccount>,
) -> Result<Vec<(http::HeaderName, http::HeaderValue)>, ProxyError> {
    let token = if let Some(credentials) = service_account {
        super::vertex_auth::access_token(credentials).await?
    } else {
        match explicit_token.map(str::trim).filter(|v| !v.is_empty()) {
            Some(token) => token.to_string(),
            None => {
                let mut cached = ADC_TOKEN.lock().await;
                if let Some((token, _)) = cached
                    .as_ref()
                    .filter(|(_, fetched)| fetched.elapsed() < Duration::from_secs(120))
                {
                    token.clone()
                } else {
                    let mut command = tokio::process::Command::new(gcloud_path());
                    command
                        .args([
                            "auth",
                            "application-default",
                            "print-access-token",
                            "--quiet",
                        ])
                        .stdin(std::process::Stdio::null())
                        .kill_on_drop(true);
                    #[cfg(windows)]
                    command.creation_flags(0x08000000);
                    let token = read_adc_token(&mut command).await?;
                    *cached = Some((token.clone(), Instant::now()));
                    token
                }
            }
        }
    };
    Ok(vec![(
        http::header::AUTHORIZATION,
        auth_header_value(&format!("Bearer {token}"))?,
    )])
}

async fn read_adc_token(command: &mut tokio::process::Command) -> Result<String, ProxyError> {
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await.map_err(|_| ProxyError::AuthError("Vertex AI ADC token refresh timed out".into()))?
        .map_err(|_| ProxyError::AuthError("Vertex AI requires gcloud on PATH; run gcloud auth application-default login, or supply an access token".into()))?;
    // Do not log stdout/stderr: both can contain credential material.
    if !output.status.success() {
        return Err(ProxyError::AuthError(
            "Vertex AI ADC authentication failed; run gcloud auth application-default login".into(),
        ));
    }
    let token = String::from_utf8(output.stdout)
        .map_err(|_| ProxyError::AuthError("Invalid Vertex AI ADC token output".into()))?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(ProxyError::AuthError(
            "Vertex AI ADC returned an empty access token".into(),
        ));
    }
    auth_header_value(&format!("Bearer {token}"))?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider() -> Provider {
        Provider::with_id("vertex".into(), "Vertex".into(), json!({}), None)
    }

    #[test]
    fn gemini_4_routes_and_normalizes_unsupported_generation_parameters() {
        for (location, host) in [
            ("global", "aiplatform.googleapis.com"),
            ("us", "aiplatform.us.rep.googleapis.com"),
            ("eu", "aiplatform.eu.rep.googleapis.com"),
        ] {
            let config = VertexAiConfig {
                project_id: "project".into(),
                location: location.into(),
                publisher: Some("google".into()),
                service_account: None,
            };
            for stream in [false, true] {
                let mut body = json!({"contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                    "generationConfig": {"maxOutputTokens": 100000, "temperature": 0.5, "candidateCount": 2,
                        "thinkingConfig": {"thinkingBudget": 10000, "thinkingLevel": "MINIMAL"}}});
                let url = prepare_gemini_request(
                    &config,
                    &provider(),
                    "gemini-4-argon",
                    stream,
                    &mut body,
                )
                .unwrap();
                let action = if stream {
                    "streamGenerateContent?alt=sse"
                } else {
                    "generateContent"
                };
                assert_eq!(url, format!("https://{host}/v1/projects/project/locations/{location}/publishers/google/models/gemini-4-argon:{action}"));
                assert_eq!(
                    body["generationConfig"]["maxOutputTokens"],
                    if stream { 65536 } else { 32768 }
                );
                assert_eq!(
                    body["generationConfig"]["thinkingConfig"],
                    json!({"thinkingLevel": "LOW"})
                );
                assert!(body["generationConfig"].get("temperature").is_none());
                assert!(body.get("anthropic_version").is_none());
            }
        }
        let config = VertexAiConfig {
            project_id: "project".into(),
            location: "us-east5".into(),
            publisher: Some("google".into()),
            service_account: None,
        };
        assert!(prepare_gemini_request(
            &config,
            &provider(),
            "gemini-4-argon",
            false,
            &mut json!({})
        )
        .is_err());
    }

    #[test]
    fn gemini_decimal_versions_route_without_allowing_unsafe_path_ids() {
        let config = VertexAiConfig {
            project_id: "project".into(),
            location: "global".into(),
            publisher: Some("google".into()),
            service_account: None,
        };
        for stream in [false, true] {
            let url = prepare_gemini_request(
                &config,
                &provider(),
                "gemini-3.8-flash",
                stream,
                &mut json!({}),
            )
            .unwrap();
            assert!(url.contains("/models/gemini-3.8-flash:"));
        }
        for model in [
            "",
            ".",
            "..",
            "../other",
            "gemini-3.8/other",
            "gemini%2fother",
            "gemini-3.8?alt=sse",
        ] {
            assert!(
                prepare_gemini_request(&config, &provider(), model, false, &mut json!({})).is_err(),
                "accepted unsafe model ID {model}"
            );
        }
    }

    #[test]
    fn routes_streaming_and_non_streaming_and_removes_model() {
        let cfg = VertexAiConfig {
            project_id: "my-project".into(),
            location: "global".into(),
            publisher: None,
            service_account: None,
        };
        for (stream, action) in [(true, "streamRawPredict"), (false, "rawPredict")] {
            let mut body = json!({"model": "claude-sonnet-5", "stream": stream, "messages": []});
            let url =
                prepare_request(&cfg, &provider(), "/v1/messages?beta=true", &mut body).unwrap();
            assert_eq!(url, format!("https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/anthropic/models/claude-sonnet-5:{action}"));
            assert!(body.get("model").is_none());
            assert_eq!(body["anthropic_version"], "vertex-2023-10-16");
            assert_eq!(body["messages"], json!([]));
        }
    }

    #[test]
    fn routes_regions_and_count_tokens() {
        for (region, host) in [
            ("us-east5", "us-east5-aiplatform.googleapis.com"),
            ("eu", "aiplatform.eu.rep.googleapis.com"),
        ] {
            let cfg = VertexAiConfig {
                project_id: "my-project".into(),
                location: region.into(),
                publisher: None,
                service_account: None,
            };
            let mut body = json!({"model": "claude-haiku-4-5@20251001"});
            let url =
                prepare_request(&cfg, &provider(), "/v1/messages/count_tokens", &mut body).unwrap();
            assert!(url.starts_with(&format!("https://{host}/v1/")));
            assert!(url.ends_with("/models/count-tokens:rawPredict"));
            assert_eq!(body["model"], "claude-haiku-4-5@20251001");
        }
    }

    #[test]
    fn rejects_missing_or_unsafe_routing_fields_and_unsupported_endpoints() {
        for (project, location, model) in [
            ("", "global", "claude-sonnet-5"),
            ("p/other", "global", "claude-sonnet-5"),
            ("project", "../global", "claude-sonnet-5"),
            ("project", "global", "../other"),
        ] {
            let cfg = VertexAiConfig {
                project_id: project.into(),
                location: location.into(),
                publisher: None,
                service_account: None,
            };
            assert!(prepare_request(
                &cfg,
                &provider(),
                "/v1/messages",
                &mut json!({"model": model})
            )
            .is_err());
        }
        let cfg = VertexAiConfig {
            project_id: "project".into(),
            location: "global".into(),
            publisher: None,
            service_account: None,
        };
        assert!(prepare_request(
            &cfg,
            &provider(),
            "/v1/messages/batches",
            &mut json!({"model": "claude-sonnet-5"})
        )
        .is_err());
    }

    #[tokio::test]
    async fn explicit_token_uses_bearer_and_rejects_header_injection() {
        let headers = auth_headers(Some("access-token"), None).await.unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, http::header::AUTHORIZATION);
        assert_eq!(headers[0].1, "Bearer access-token");
        assert!(auth_headers(Some("token\r\nx-api-key: leak"), None)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn adc_process_output_is_validated_and_errors_do_not_expose_credentials() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printf 'adc-token\\n'"]);
        assert_eq!(read_adc_token(&mut command).await.unwrap(), "adc-token");

        for script in [
            "printf ''",
            "printf 'token\\nx-api-key: injected'",
            "printf 'private-credential' >&2; exit 1",
        ] {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", script]);
            let error = read_adc_token(&mut command).await.unwrap_err().to_string();
            assert!(!error.contains("private-credential"));
            assert!(!error.contains("injected"));
        }
    }
}
