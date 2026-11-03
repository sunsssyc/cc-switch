//! Gemini authentication type detection
//!
//! Detects whether a Gemini provider uses PackyCode API Key, Google OAuth, Vertex AI, or generic API Key.

use crate::provider::Provider;

/// Gemini authentication type enumeration
///
/// Used to optimize performance by avoiding repeated provider type detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GeminiAuthType {
    /// PackyCode provider (uses API Key)
    Packycode,
    /// Google Official (uses OAuth)
    GoogleOfficial,
    /// Vertex AI (uses ADC or a service account)
    Vertex,
    /// Generic Gemini provider (uses API Key)
    Generic,
}

// Partner Promotion Key constants
const PACKYCODE_PARTNER_KEY: &str = "packycode";
const GOOGLE_OFFICIAL_PARTNER_KEY: &str = "google-official";

// PackyCode keyword constants
const PACKYCODE_KEYWORDS: [&str; 3] = ["packycode", "packyapi", "packy"];

/// Detect Gemini provider authentication type
///
/// One-time detection to avoid repeated calls to `is_packycode_gemini` and `is_google_official_gemini`.
///
/// # Returns
///
/// - `GeminiAuthType::GoogleOfficial`: Google official, uses OAuth
/// - `GeminiAuthType::Packycode`: PackyCode provider, uses API Key
/// - `GeminiAuthType::Vertex`: Vertex AI, uses ADC or a service account
/// - `GeminiAuthType::Generic`: Other generic providers, uses API Key
pub(crate) fn detect_gemini_auth_type(provider: &Provider) -> GeminiAuthType {
    // Priority 0: Vertex AI is a distinct auth mode. Check meta and the env selector
    // before name matching, otherwise "Google Vertex AI" would be mistaken for the
    // Google OAuth card and fail with a project that has no ADC.
    if provider
        .meta
        .as_ref()
        .and_then(|meta| meta.vertex_ai.as_ref())
        .is_some()
        || provider
            .settings_config
            .pointer("/env/GOOGLE_GENAI_USE_VERTEXAI")
            .and_then(|value| value.as_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("true") || value.trim() == "1")
    {
        return GeminiAuthType::Vertex;
    }

    // Priority 1: Check partner_promotion_key (most reliable)
    if let Some(key) = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.partner_promotion_key.as_deref())
    {
        if key.eq_ignore_ascii_case(GOOGLE_OFFICIAL_PARTNER_KEY) {
            return GeminiAuthType::GoogleOfficial;
        }
        if key.eq_ignore_ascii_case(PACKYCODE_PARTNER_KEY) {
            return GeminiAuthType::Packycode;
        }
    }

    // Priority 2: Check Google Official (name matching)
    let name_lower = provider.name.to_ascii_lowercase();
    if name_lower == "google" || name_lower.starts_with("google ") {
        return GeminiAuthType::GoogleOfficial;
    }

    // Priority 3: Check PackyCode keywords
    if contains_packycode_keyword(&provider.name) {
        return GeminiAuthType::Packycode;
    }

    if let Some(site) = provider.website_url.as_deref() {
        if contains_packycode_keyword(site) {
            return GeminiAuthType::Packycode;
        }
    }

    if let Some(base_url) = provider
        .settings_config
        .pointer("/env/GOOGLE_GEMINI_BASE_URL")
        .and_then(|v| v.as_str())
    {
        if contains_packycode_keyword(base_url) {
            return GeminiAuthType::Packycode;
        }
    }

    GeminiAuthType::Generic
}

/// Check if string contains PackyCode related keywords (case-insensitive)
///
/// Keyword list: ["packycode", "packyapi", "packy"]
fn contains_packycode_keyword(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    PACKYCODE_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

/// Detect if provider is Google Official Gemini (uses OAuth authentication)
///
/// Google Official Gemini uses OAuth personal authentication, no API Key needed.
///
/// This is a convenience wrapper around `detect_gemini_auth_type`.
pub(crate) fn is_google_official_gemini(provider: &Provider) -> bool {
    detect_gemini_auth_type(provider) == GeminiAuthType::GoogleOfficial
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(name: &str, env: serde_json::Value) -> Provider {
        Provider::with_id("p".into(), name.into(), json!({ "env": env }), None)
    }

    #[test]
    fn vertex_selector_and_metadata_are_not_google_oauth() {
        let by_name = provider(
            "Google Vertex AI",
            json!({"GOOGLE_GENAI_USE_VERTEXAI": "true"}),
        );
        assert_eq!(detect_gemini_auth_type(&by_name), GeminiAuthType::Vertex);
        assert!(!is_google_official_gemini(&by_name));

        let mut by_meta = provider("Custom", json!({}));
        by_meta.meta = Some(crate::provider::ProviderMeta {
            vertex_ai: Some(crate::provider::VertexAiConfig {
                project_id: "p".into(),
                location: "global".into(),
                publisher: Some("google".into()),
                service_account: None,
            }),
            ..Default::default()
        });
        assert_eq!(detect_gemini_auth_type(&by_meta), GeminiAuthType::Vertex);
    }

    #[test]
    fn google_official_and_api_key_cards_keep_their_types() {
        let official = provider("Google Official", json!({}));
        assert_eq!(
            detect_gemini_auth_type(&official),
            GeminiAuthType::GoogleOfficial
        );

        let api_key = provider(
            "Example",
            json!({"GEMINI_API_KEY": "key", "GOOGLE_GEMINI_BASE_URL": "https://example.com"}),
        );
        assert_eq!(detect_gemini_auth_type(&api_key), GeminiAuthType::Generic);
    }
}
