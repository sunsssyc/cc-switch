import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { providersApi } from "@/lib/api/providers";
import { toast } from "@/lib/toast";
import type { VertexServiceAccount } from "@/types";
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
  publisher,
  serviceAccount,
  onServiceAccountChange,
}: {
  projectId: string;
  location: string;
  onChange: (field: "projectId" | "location", value: string) => void;
  accessToken?: string;
  onAccessTokenChange?: (value: string) => void;
  isGemini?: boolean;
  publisher?: string;
  serviceAccount?: VertexServiceAccount;
  onServiceAccountChange?: (credentials?: VertexServiceAccount) => void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const importSequence = useRef(0);
  const [importing, setImporting] = useState(false);
  useEffect(
    () => () => {
      importSequence.current += 1;
    },
    [],
  );

  const importKey = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const sequence = ++importSequence.current;
    setImporting(true);
    try {
      if (file.size > 1024 * 1024) throw new Error("file-too-large");
      const json = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reader.onabort = () =>
          reject(new Error("read-failed"));
        reader.readAsText(file);
      });
      const credentials = await providersApi.importVertexServiceAccount(json);
      if (sequence === importSequence.current)
        onServiceAccountChange?.(credentials);
    } catch {
      if (sequence === importSequence.current)
        toast.error(t("vertexAi.invalidServiceAccount"));
    } finally {
      if (sequence === importSequence.current) setImporting(false);
    }
  };
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
      {onServiceAccountChange && (
        <div className="space-y-2">
          <Label htmlFor="vertex-service-account">
            {t("vertexAi.serviceAccount")}
          </Label>
          <input
            id="vertex-service-account"
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={importKey}
          />
          {serviceAccount && (
            <p
              className="truncate text-sm text-fg-2"
              title={serviceAccount.client_email}
            >
              {serviceAccount.client_email}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => fileInput.current?.click()}
            >
              {t(
                importing
                  ? "vertexAi.importing"
                  : serviceAccount
                    ? "vertexAi.replaceServiceAccount"
                    : "vertexAi.importServiceAccount",
              )}
            </Button>
            {serviceAccount && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={importing}
                onClick={() => onServiceAccountChange()}
              >
                {t("vertexAi.removeServiceAccount")}
              </Button>
            )}
          </div>
        </div>
      )}
      {onAccessTokenChange && !serviceAccount && (
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
          serviceAccount
            ? "vertexAi.serviceAccountHint"
            : publisher === "auto"
              ? "vertexAi.authHint"
              : isGemini
                ? "vertexAi.geminiAuthHint"
                : onAccessTokenChange
                  ? "vertexAi.codexAuthHint"
                  : "vertexAi.claudeAuthHint",
        )}
      </p>
    </div>
  );
}
