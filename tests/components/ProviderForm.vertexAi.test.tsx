import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { createTestQueryClient } from "../utils/testQueryClient";
import { toast } from "@/lib/toast";

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

function renderVertex(appId: "claude" | "codex", projectId = "my-project") {
  const onSubmit = vi.fn();
  const claude = providerPresets.find((p) => p.name === "Google Vertex AI")!;
  const codex = codexProviderPresets.find(
    (p) => p.name === "Google Vertex AI",
  )!;
  const settingsConfig =
    appId === "claude"
      ? {
          env: {
            ...(claude.settingsConfig as { env: Record<string, string> }).env,
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
          meta:
            appId === "codex"
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
            "Google Vertex AI (Gemini)",
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
        publisher: "google",
      });
      const settings = JSON.parse(payload.settingsConfig);
      if (appId === "claude") {
        expect(payload.meta.apiFormat).toBe("gemini_native");
        expect(settings.env.ANTHROPIC_MODEL).toBe("gemini-4-argon");
        expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("google-token");
        expect(settings.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
        expect(
          payload.meta.stackModels.map((m: { model: string }) => m.model),
        ).toEqual(["gemini-4-argon", "gemini-3.8-flash"]);
      } else {
        expect(settings.config).toContain('model = "gemini-4-argon"');
        expect(settings.auth.OPENAI_API_KEY).toBe("google-token");
        expect(
          settings.modelCatalog.models.map((m: { model: string }) => m.model),
        ).toEqual(["gemini-4-argon", "gemini-3.8-flash"]);
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
        });
        expect(payload.meta.apiFormat).toBe("anthropic");
      } else {
        expect(
          JSON.parse(payload.settingsConfig).env.ANTHROPIC_VERTEX_PROJECT_ID,
        ).toBe("new-project");
      }
    },
  );
});
