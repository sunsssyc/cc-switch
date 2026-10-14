import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { createTestQueryClient } from "../utils/testQueryClient";
import { toast } from "@/lib/toast";
import { providersApi } from "@/lib/api/providers";
import type { VertexServiceAccount } from "@/types";

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/JsonEditor", () => ({ default: () => <div /> }));
vi.mock("@/components/providers/forms/CodexConfigEditor", () => ({
  default: () => <div />,
}));
vi.mock("@/components/providers/forms/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/forms/hooks")>();
  const signedOut = {
    isAuthenticated: false,
    isStatusSuccess: true,
    isStatusError: false,
    accounts: [],
  };
  return {
    ...actual,
    useCopilotAuth: () => signedOut,
    useCodexOauth: () => signedOut,
    useXaiOauth: () => signedOut,
  };
});

function renderVertex(
  appId: "claude" | "codex",
  projectId = "my-project",
  serviceAccount?: VertexServiceAccount,
) {
  const onSubmit = vi.fn();
  const codex = codexProviderPresets.find(
    (p) => p.name === "Google Vertex AI",
  )!;
  const settingsConfig =
    appId === "claude"
      ? {
          env: {
            CLAUDE_CODE_USE_VERTEX: "1",
            CLOUD_ML_REGION: "global",
            ANTHROPIC_MODEL: "claude-sonnet-5",
            ANTHROPIC_VERTEX_PROJECT_ID: projectId,
          },
        }
      : { auth: codex.auth, config: codex.config };
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId={appId}
        providerId="vertex"
        submitLabel="save-vertex"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={{
          name: "Google Vertex AI",
          category: "cloud_provider",
          settingsConfig,
          meta: serviceAccount
            ? {
                apiFormat: "anthropic",
                vertexAi: {
                  projectId,
                  location: "global",
                  publisher: "auto",
                  serviceAccount,
                },
              }
            : appId === "codex"
              ? {
                  apiFormat: "anthropic",
                  vertexAi: { projectId, location: "global" },
                }
              : undefined,
        }}
      />
    </QueryClientProvider>,
  );
  return onSubmit;
}

describe("Vertex AI provider editing", () => {
  it.each(["claude", "codex"] as const)(
    "adds Gemini 4 for %s with cloud authentication and routing",
    async (appId) => {
      const submit = vi.fn();
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId={appId}
            submitLabel="add-gemini"
            onSubmit={submit}
            onCancel={vi.fn()}
          />
        </QueryClientProvider>,
      );
      const preset = screen
        .getAllByRole("button")
        .find(
          (button) =>
            button.querySelector("span.truncate")?.textContent ===
            "Google Vertex AI",
        );
      fireEvent.click(preset!);
      fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
        target: { value: "gemini-project" },
      });
      fireEvent.change(screen.getByLabelText("vertexAi.accessToken"), {
        target: { value: "google-token" },
      });
      fireEvent.change(screen.getByLabelText("vertexAi.location"), {
        target: { value: "us-east5" },
      });
      fireEvent.click(screen.getByRole("button", { name: "add-gemini" }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "vertexAi.geminiLocationRequired",
        ),
      );
      expect(submit).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("vertexAi.location"), {
        target: { value: "global" },
      });
      fireEvent.click(screen.getByRole("button", { name: "add-gemini" }));
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      const payload = submit.mock.calls[0][0];
      expect(payload.meta.vertexAi).toEqual({
        projectId: "gemini-project",
        location: "global",
        publisher: "auto",
      });
      const settings = JSON.parse(payload.settingsConfig);
      if (appId === "claude") {
        expect(payload.meta.apiFormat).toBe("gemini_native");
        expect(settings.env.ANTHROPIC_MODEL).toBe("gemini-4-argon");
        expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("google-token");
        expect(settings.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
        expect(
          payload.meta.stackModels.map((m: { model: string }) => m.model),
        ).toEqual([
          "claude-sonnet-5",
          "claude-opus-5",
          "gemini-4-argon",
          "gemini-3.8-flash",
        ]);
      } else {
        expect(settings.config).toContain('model = "gemini-4-argon"');
        expect(settings.auth.OPENAI_API_KEY).toBe("google-token");
        expect(
          settings.modelCatalog.models.map((m: { model: string }) => m.model),
        ).toEqual([
          "claude-sonnet-5",
          "claude-opus-5",
          "gemini-4-argon",
          "gemini-3.8-flash",
        ]);
      }
    },
  );
  it("saves Claude native project and region without adding an Anthropic API key", async () => {
    const submit = renderVertex("claude");
    fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
      target: { value: "updated-project" },
    });
    fireEvent.change(screen.getByLabelText("vertexAi.location"), {
      target: { value: "us-east5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-vertex" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const settings = JSON.parse(submit.mock.calls[0][0].settingsConfig);
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "updated-project",
      CLOUD_ML_REGION: "us-east5",
    });
    expect(settings.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("saves Codex Vertex metadata and optional access token while keeping the bridge format", async () => {
    const submit = renderVertex("codex");
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
      target: { value: "updated-project" },
    });
    fireEvent.change(screen.getByLabelText("vertexAi.location"), {
      target: { value: "eu" },
    });
    fireEvent.change(screen.getByLabelText("vertexAi.accessToken"), {
      target: { value: "google-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-vertex" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const payload = submit.mock.calls[0][0];
    expect(payload.meta.vertexAi).toEqual({
      projectId: "updated-project",
      location: "eu",
    });
    expect(payload.meta.apiFormat).toBe("anthropic");
    expect(JSON.parse(payload.settingsConfig).auth.OPENAI_API_KEY).toBe(
      "google-token",
    );
  });

  it("permits Codex gcloud authentication without a static token", async () => {
    const submit = renderVertex("codex");
    fireEvent.click(screen.getByRole("button", { name: "save-vertex" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(
      JSON.parse(submit.mock.calls[0][0].settingsConfig).auth.OPENAI_API_KEY ??
        "",
    ).toBe("");
  });

  it("blocks saving an incomplete Vertex project", async () => {
    const submit = renderVertex("codex", "");
    fireEvent.click(screen.getByRole("button", { name: "save-vertex" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("vertexAi.invalidConfig"),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)(
    "adds the Vertex preset for %s",
    async (appId) => {
      const submit = vi.fn();
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId={appId}
            submitLabel="add-vertex"
            onSubmit={submit}
            onCancel={vi.fn()}
          />
        </QueryClientProvider>,
      );
      const preset = screen
        .getAllByRole("button")
        .find(
          (button) =>
            button.querySelector("span.truncate")?.textContent ===
            "Google Vertex AI",
        );
      expect(preset).toBeDefined();
      expect(
        screen
          .getAllByRole("button")
          .filter((button) =>
            button
              .querySelector("span.truncate")
              ?.textContent?.startsWith("Google Vertex AI"),
          ),
      ).toHaveLength(1);
      fireEvent.click(preset!);
      fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
        target: { value: "new-project" },
      });
      fireEvent.click(screen.getByRole("button", { name: "add-vertex" }));
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      const payload = submit.mock.calls[0][0];
      if (appId === "codex") {
        expect(payload.meta.vertexAi).toEqual({
          projectId: "new-project",
          location: "global",
          publisher: "auto",
        });
        expect(payload.meta.apiFormat).toBe("anthropic");
      } else {
        expect(payload.meta.vertexAi.projectId).toBe("new-project");
      }
    },
  );
});

const serviceAccount: VertexServiceAccount = {
  type: "service_account",
  project_id: "key-project",
  private_key_id: "test-id",
  private_key: "fixture-private-key",
  client_email: "test@key-project.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

function renderNewVertex(appId: "claude" | "codex") {
  const submit = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId={appId}
        submitLabel="save-key"
        onSubmit={submit}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const preset = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.querySelector("span.truncate")?.textContent ===
        "Google Vertex AI",
    );
  fireEvent.click(preset!);
  return submit;
}

function uploadKey() {
  fireEvent.change(screen.getByLabelText("vertexAi.serviceAccount"), {
    target: {
      files: [
        new File([JSON.stringify(serviceAccount)], "key.json", {
          type: "application/json",
        }),
      ],
    },
  });
}

describe("Vertex service account JSON import", () => {
  it.each(["claude", "codex"] as const)(
    "imports credentials and saves %s without a token or gcloud",
    async (appId) => {
      vi.spyOn(providersApi, "importVertexServiceAccount").mockResolvedValue(
        serviceAccount,
      );
      const submit = renderNewVertex(appId);
      fireEvent.change(screen.getByLabelText("vertexAi.accessToken"), {
        target: { value: "old-static-token" },
      });
      uploadKey();
      await screen.findByText(serviceAccount.client_email);
      expect(providersApi.importVertexServiceAccount).toHaveBeenCalledWith(
        JSON.stringify(serviceAccount),
      );
      expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue(
        "key-project",
      );
      expect(
        screen.queryByLabelText("vertexAi.accessToken"),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "save-key" }));
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      const payload = submit.mock.calls[0][0];
      expect(payload.meta.vertexAi.serviceAccount).toEqual(serviceAccount);
      expect(payload.settingsConfig).not.toContain(serviceAccount.private_key);
      expect(payload.settingsConfig).not.toContain("old-static-token");
    },
  );

  it("keeps a selected target project, replaces credentials and can remove them", async () => {
    const importer = vi
      .spyOn(providersApi, "importVertexServiceAccount")
      .mockResolvedValue(serviceAccount);
    const submit = renderNewVertex("codex");
    fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
      target: { value: "other-project" },
    });
    uploadKey();
    await screen.findByText(serviceAccount.client_email);
    expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue(
      "other-project",
    );
    const replacement = {
      ...serviceAccount,
      client_email: "new@key-project.iam.gserviceaccount.com",
      private_key_id: "new-key",
    };
    importer.mockResolvedValue(replacement);
    uploadKey();
    await screen.findByText(replacement.client_email);
    fireEvent.click(
      screen.getByRole("button", { name: "vertexAi.removeServiceAccount" }),
    );
    expect(
      screen.queryByText(replacement.client_email),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("vertexAi.accessToken")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "save-key" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(
      submit.mock.calls[0][0].meta.vertexAi.serviceAccount,
    ).toBeUndefined();
  });

  it("rejects invalid JSON without discarding the previous key", async () => {
    const importer = vi
      .spyOn(providersApi, "importVertexServiceAccount")
      .mockResolvedValue(serviceAccount);
    renderNewVertex("claude");
    uploadKey();
    await screen.findByText(serviceAccount.client_email);
    importer.mockRejectedValue(new Error("Invalid credentials"));
    uploadKey();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "vertexAi.invalidServiceAccount",
      ),
    );
    expect(screen.getByText(serviceAccount.client_email)).toBeInTheDocument();
  });

  it.each(["claude", "codex"] as const)(
    "preserves an imported key when editing %s",
    async (appId) => {
      const submit = renderVertex(appId, "my-project", serviceAccount);
      expect(screen.getByText(serviceAccount.client_email)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "save-vertex" }));
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      expect(submit.mock.calls[0][0].meta.vertexAi.serviceAccount).toEqual(
        serviceAccount,
      );
    },
  );
});
