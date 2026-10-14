//! Gemini tool schema helpers.
//!
//! Gemini `FunctionDeclaration` supports two schema channels:
//! - `parameters`: a restricted `Schema` subset
//! - `parametersJsonSchema`: richer JSON Schema via arbitrary JSON `Value`
//!
//! Anthropic tool schemas are closer to JSON Schema, so we choose the richer
//! channel when unsupported `Schema` fields are present.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum GeminiFunctionParameters {
    Schema(Value),
    JsonSchema(Value),
}

pub fn build_gemini_function_parameters(input_schema: Value) -> GeminiFunctionParameters {
    let mut schema = ensure_object_schema(normalize_json_schema(input_schema));
    simplify_recursive_json_values(&mut schema);

    if requires_parameters_json_schema(&schema) {
        GeminiFunctionParameters::JsonSchema(schema)
    } else {
        GeminiFunctionParameters::Schema(to_gemini_schema(schema))
    }
}

/// Codex desktop tools describe arbitrary JSON with a six-way recursive union.
/// Vertex rejects the recursion through `additionalProperties`, even though an
/// empty object terminates it. For this exact union, unconstrained array items
/// and map values accept precisely the same JSON values, without a ref loop.
/// Do not weaken other recursive schemas (e.g. a constrained tree).
fn simplify_recursive_json_values(schema: &mut Value) {
    for keyword in ["$defs", "definitions"] {
        let Some(definitions) = schema.get_mut(keyword).and_then(Value::as_object_mut) else {
            continue;
        };
        for (name, definition) in definitions {
            let reference = format!("#/{keyword}/{}", name.replace('~', "~0").replace('/', "~1"));
            let expected = [
                json!({"type": "null"}),
                json!({"type": "boolean"}),
                json!({"type": "number"}),
                json!({"type": "string"}),
                json!({"type": "array", "items": {"$ref": reference}}),
                json!({"type": "object", "additionalProperties": {"$ref": reference}}),
            ];
            let Some(object) = definition.as_object_mut() else {
                continue;
            };
            // Only annotations may accompany the union; other keywords can
            // constrain its values and invalidate this equivalence.
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "anyOf" | "title" | "description"))
            {
                continue;
            }
            let Some(branches) = object.get_mut("anyOf").and_then(Value::as_array_mut) else {
                continue;
            };
            if branches.len() != expected.len()
                || !expected.iter().all(|branch| branches.contains(branch))
            {
                continue;
            }
            for branch in branches {
                match branch["type"].as_str() {
                    Some("array") => branch["items"] = json!({}),
                    Some("object") => branch["additionalProperties"] = json!(true),
                    _ => {}
                }
            }
        }
    }
}

/// Vertex AI rejects FunctionDeclarations whose `parameters` schema lacks an
/// explicit `type: "object"`, returning:
///
/// > functionDeclaration parameters schema should be of type OBJECT.
///
/// Anthropic tools sometimes arrive with empty or type-less `input_schema`
/// (e.g. no-argument tools like Claude Code's `TodoRead`). Normalize those to
/// `{type: "object", properties: {}}` so the Gemini upstream accepts them.
///
/// References: google-gemini/generative-ai-python#423, BerriAI/litellm#5055.
fn ensure_object_schema(schema: Value) -> Value {
    match schema {
        Value::Object(mut obj) => {
            obj.entry("type".to_string())
                .or_insert_with(|| json!("object"));
            if obj.get("type").and_then(|v| v.as_str()) == Some("object") {
                obj.entry("properties".to_string())
                    .or_insert_with(|| json!({}));
            }
            Value::Object(obj)
        }
        other => other,
    }
}

fn normalize_json_schema(schema: Value) -> Value {
    match schema {
        Value::Object(mut obj) => {
            obj.remove("$schema");
            obj.remove("$id");

            if let Some(properties) = obj
                .get_mut("properties")
                .and_then(|value| value.as_object_mut())
            {
                for value in properties.values_mut() {
                    *value = normalize_json_schema(value.clone());
                }
            }

            if let Some(items) = obj.get_mut("items") {
                *items = normalize_json_schema(items.clone());
            }

            for key in ["anyOf", "oneOf", "allOf", "prefixItems"] {
                if let Some(values) = obj.get_mut(key).and_then(|value| value.as_array_mut()) {
                    for value in values.iter_mut() {
                        *value = normalize_json_schema(value.clone());
                    }
                }
            }

            for key in ["not", "if", "then", "else", "additionalProperties"] {
                if let Some(value) = obj.get_mut(key) {
                    *value = normalize_json_schema(value.clone());
                }
            }

            Value::Object(obj)
        }
        Value::Array(values) => {
            Value::Array(values.into_iter().map(normalize_json_schema).collect())
        }
        other => other,
    }
}

fn requires_parameters_json_schema(schema: &Value) -> bool {
    match schema {
        Value::Object(obj) => object_requires_parameters_json_schema(obj),
        Value::Array(values) => values.iter().any(requires_parameters_json_schema),
        _ => false,
    }
}

fn object_requires_parameters_json_schema(obj: &Map<String, Value>) -> bool {
    for (key, value) in obj {
        match key.as_str() {
            "type" => {
                if value.is_array() {
                    return true;
                }
            }
            "format" | "title" | "description" | "nullable" | "enum" | "maxItems" | "minItems"
            | "required" | "minProperties" | "maxProperties" | "minLength" | "maxLength"
            | "pattern" | "example" | "propertyOrdering" | "default" | "minimum" | "maximum" => {}
            "properties" => {
                let Some(properties) = value.as_object() else {
                    return true;
                };
                if properties.values().any(requires_parameters_json_schema) {
                    return true;
                }
            }
            "items" => {
                if !value.is_object() || requires_parameters_json_schema(value) {
                    return true;
                }
            }
            "anyOf" => {
                let Some(values) = value.as_array() else {
                    return true;
                };
                if values.iter().any(requires_parameters_json_schema) {
                    return true;
                }
            }
            // JSON Schema keywords that Gemini `parameters` does not accept.
            "$ref"
            | "$defs"
            | "definitions"
            | "additionalProperties"
            | "unevaluatedProperties"
            | "patternProperties"
            | "oneOf"
            | "allOf"
            | "const"
            | "not"
            | "if"
            | "then"
            | "else"
            | "dependentRequired"
            | "dependentSchemas"
            | "contains"
            | "minContains"
            | "maxContains"
            | "prefixItems"
            | "exclusiveMinimum"
            | "exclusiveMaximum"
            | "multipleOf"
            | "examples" => return true,
            // Be conservative for unknown keywords.
            _ => return true,
        }
    }

    false
}

fn to_gemini_schema(schema: Value) -> Value {
    match schema {
        Value::Object(obj) => {
            let mut result = Map::new();

            for (key, value) in obj {
                match key.as_str() {
                    "type" | "format" | "title" | "description" | "nullable" | "enum"
                    | "maxItems" | "minItems" | "required" | "minProperties" | "maxProperties"
                    | "minLength" | "maxLength" | "pattern" | "example" | "propertyOrdering"
                    | "default" | "minimum" | "maximum" => {
                        result.insert(key, value);
                    }
                    "properties" => {
                        if let Some(properties) = value.as_object() {
                            let converted = properties
                                .iter()
                                .map(|(name, property_schema)| {
                                    (name.clone(), to_gemini_schema(property_schema.clone()))
                                })
                                .collect();
                            result.insert("properties".to_string(), Value::Object(converted));
                        }
                    }
                    "items" if value.is_object() => {
                        result.insert("items".to_string(), to_gemini_schema(value));
                    }
                    "anyOf" => {
                        if let Some(values) = value.as_array() {
                            result.insert(
                                "anyOf".to_string(),
                                Value::Array(
                                    values
                                        .iter()
                                        .map(|value| to_gemini_schema(value.clone()))
                                        .collect(),
                                ),
                            );
                        }
                    }
                    _ => {}
                }
            }

            Value::Object(result)
        }
        other => other,
    }
}

pub fn build_gemini_function_declaration(
    name: &str,
    description: Option<&str>,
    input_schema: Value,
) -> Value {
    let mut declaration = Map::new();
    declaration.insert("name".to_string(), json!(name));
    declaration.insert("description".to_string(), json!(description.unwrap_or("")));

    match build_gemini_function_parameters(input_schema) {
        GeminiFunctionParameters::Schema(schema) => {
            declaration.insert("parameters".to_string(), schema);
        }
        GeminiFunctionParameters::JsonSchema(schema) => {
            declaration.insert("parametersJsonSchema".to_string(), schema);
        }
    }

    Value::Object(declaration)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recursive_json_tool() -> Value {
        json!({
            "type": "object", "required": ["payload"],
            "properties": {"payload": {"$ref": "#/$defs/__schema0"}},
            "$defs": {"__schema0": {"anyOf": [
                {"type": "string"}, {"type": "number"},
                {"type": "boolean"}, {"type": "null"},
                {"type": "array", "items": {"$ref": "#/$defs/__schema0"}},
                {"type": "object", "additionalProperties": {"$ref": "#/$defs/__schema0"}}
            ]}}
        })
    }

    #[test]
    fn codex_arbitrary_json_tool_has_no_recursive_map_or_array_refs() {
        let mut input = recursive_json_tool();
        let literal = json!({"$ref": "#/$defs/__schema0"});
        input["properties"]["payload"]["default"] = literal.clone();
        let result = build_gemini_function_declaration("automation_update", None, input);
        let schema = &result["parametersJsonSchema"];
        assert_eq!(schema["$defs"]["__schema0"]["anyOf"][4]["items"], json!({}));
        assert_eq!(
            schema["$defs"]["__schema0"]["anyOf"][5]["additionalProperties"],
            true
        );
        assert_eq!(schema["properties"]["payload"]["$ref"], "#/$defs/__schema0");
        assert_eq!(schema["properties"]["payload"]["default"], literal);
        assert_eq!(schema["required"], json!(["payload"]));
    }

    #[test]
    fn constrained_recursive_values_are_not_weakened() {
        for constraint in ["minItems", "maxItems"] {
            let mut input = recursive_json_tool();
            input["$defs"]["__schema0"]["anyOf"][4][constraint] = json!(1);
            assert_eq!(
                build_gemini_function_declaration("tree", None, input.clone())
                    ["parametersJsonSchema"],
                input
            );
        }
        let mut input = recursive_json_tool();
        input["$defs"]["__schema0"]["anyOf"]
            .as_array_mut()
            .unwrap()
            .remove(3);
        assert_eq!(
            build_gemini_function_declaration("tree", None, input.clone())["parametersJsonSchema"],
            input
        );
    }

    #[test]
    fn uses_schema_for_simple_openapi_subset() {
        let schema = json!({
            "type": "object",
            "properties": {
                "city": { "type": "string", "description": "Target city" }
            },
            "required": ["city"]
        });

        let result = build_gemini_function_declaration("weather", Some("Weather lookup"), schema);

        assert!(result.get("parameters").is_some());
        assert!(result.get("parametersJsonSchema").is_none());
        assert_eq!(result["parameters"]["properties"]["city"]["type"], "string");
    }

    #[test]
    fn uses_parameters_json_schema_for_additional_properties() {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "city": { "type": "string" }
            },
            "required": ["city"],
            "additionalProperties": false
        });

        let result = build_gemini_function_declaration("weather", Some("Weather lookup"), schema);

        assert!(result.get("parameters").is_none());
        assert!(result.get("parametersJsonSchema").is_some());
        assert!(result["parametersJsonSchema"].get("$schema").is_none());
        assert_eq!(
            result["parametersJsonSchema"]["additionalProperties"],
            false
        );
    }

    #[test]
    fn uses_parameters_json_schema_for_one_of() {
        let schema = json!({
            "type": "object",
            "properties": {
                "target": {
                    "oneOf": [
                        { "type": "string" },
                        { "type": "integer" }
                    ]
                }
            }
        });

        let result = build_gemini_function_declaration("search", Some("Search"), schema);

        assert!(result.get("parameters").is_none());
        assert!(result.get("parametersJsonSchema").is_some());
    }

    /// Regression for P2 (Vertex AI rejecting empty schemas): zero-argument
    /// Anthropic tools (no `input_schema`) must produce `parameters` with an
    /// explicit `type: "object"` and an empty `properties` map so the Gemini
    /// upstream does not return `schema should be of type OBJECT`.
    #[test]
    fn empty_input_schema_produces_explicit_object_type() {
        let result = build_gemini_function_declaration("ping", Some("no-arg"), json!({}));

        assert_eq!(result["parameters"]["type"], "object");
        assert!(result["parameters"]["properties"].is_object());
    }

    /// A schema that carries descriptive fields but no `type` is still a
    /// zero-arg object for Gemini purposes — promote it explicitly.
    #[test]
    fn input_schema_missing_type_is_promoted_to_object() {
        let result = build_gemini_function_declaration(
            "noop",
            None,
            json!({ "description": "does nothing" }),
        );

        assert_eq!(result["parameters"]["type"], "object");
        assert!(result["parameters"]["properties"].is_object());
    }

    /// Defensive: an atomic (non-object) schema is left untouched, because
    /// forcing `type: "object"` here would corrupt primitive parameter types
    /// that happen to flow through this path.
    #[test]
    fn non_object_schema_is_not_mutated() {
        let result = build_gemini_function_declaration("bare", None, json!({ "type": "string" }));

        assert_eq!(result["parameters"]["type"], "string");
        assert!(result["parameters"].get("properties").is_none());
    }
}
