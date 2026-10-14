import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import ApiKeyInput from "./ApiKeyInput";

export function VertexAiFields({
  projectId,
  location,
  onChange,
  accessToken,
  onAccessTokenChange,
  isGemini = false,
}: {
  projectId: string;
  location: string;
  onChange: (field: "projectId" | "location", value: string) => void;
  accessToken?: string;
  onAccessTokenChange?: (value: string) => void;
  isGemini?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="vertex-project">{t("vertexAi.projectId")}</Label>
        <ImeSafeInput
          id="vertex-project"
          value={projectId}
          placeholder="my-gcp-project"
          onValueChange={(value) => onChange("projectId", value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="vertex-location">{t("vertexAi.location")}</Label>
        <ImeSafeInput
          id="vertex-location"
          value={location}
          placeholder={isGemini ? "global / us / eu" : "global / us-east5"}
          onValueChange={(value) => onChange("location", value)}
        />
      </div>
      {onAccessTokenChange && (
        <ApiKeyInput
          id="vertex-access-token"
          label={t("vertexAi.accessToken")}
          value={accessToken ?? ""}
          onChange={onAccessTokenChange}
          placeholder={t("vertexAi.accessTokenPlaceholder")}
        />
      )}
      <p className="text-xs leading-relaxed text-fg-2">
        {t(
          isGemini
            ? "vertexAi.geminiAuthHint"
            : onAccessTokenChange
              ? "vertexAi.codexAuthHint"
              : "vertexAi.claudeAuthHint",
        )}
      </p>
    </div>
  );
}
