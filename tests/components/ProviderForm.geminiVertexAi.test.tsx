import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
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

function renderNewGemini() {
  const submit = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId="gemini"
        submitLabel="save-gemini"
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
  return submit;
}

function renderExistingGemini() {
  const submit = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId="gemini"
        providerId="vertex-gemini"
        submitLabel="save-gemini"
        onSubmit={submit}
        onCancel={vi.fn()}
        initialData={{
          name: "Google Vertex AI",
          category: "cloud_provider",
          settingsConfig: {
            env: {
              GOOGLE_GENAI_USE_VERTEXAI: "true",
              GOOGLE_CLOUD_PROJECT: "old-project",
              GOOGLE_CLOUD_LOCATION: "global",
              GEMINI_MODEL: "gemini-3.8-flash",
            },
            config: {},
          },
          meta: {
            vertexAi: {
              projectId: "old-project",
              location: "global",
              publisher: "google",
            },
          },
        }}
      />
    </QueryClientProvider>,
  );
  return submit;
}

describe("Gemini CLI Vertex AI provider", () => {
  it("adds the Vertex preset with project, location and ADC", async () => {
    const submit = renderNewGemini();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue("");
    expect(screen.getByLabelText("vertexAi.location")).toHaveValue("global");

    fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
      target: { value: "gemini-project" },
    });
    fireEvent.change(screen.getByLabelText("vertexAi.location"), {
      target: { value: "us-east5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-gemini" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "vertexAi.geminiLocationRequired",
      ),
    );
    expect(submit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("vertexAi.location"), {
      target: { value: "global" },
    });
    fireEvent.change(screen.getByLabelText("vertexAi.credentialsPath"), {
      target: { value: "/keys/vertex.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-gemini" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());

    const payload = submit.mock.calls[0][0];
    const settings = JSON.parse(payload.settingsConfig);
    expect(settings.env).toMatchObject({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "gemini-project",
      GOOGLE_CLOUD_LOCATION: "global",
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/vertex.json",
      GEMINI_MODEL: "gemini-3.8-flash",
    });
    expect(settings.env).not.toHaveProperty("GEMINI_API_KEY");
    expect(settings.env).not.toHaveProperty("GOOGLE_GEMINI_BASE_URL");
    expect(payload.meta.vertexAi).toEqual({
      projectId: "gemini-project",
      location: "global",
      publisher: "google",
    });
    expect(payload.meta.apiFormat).toBeUndefined();
  });

  it("edits an existing Vertex row and keeps the env in sync", async () => {
    const submit = renderExistingGemini();
    expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue(
      "old-project",
    );
    expect(screen.getByLabelText("vertexAi.location")).toHaveValue("global");

    fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
      target: { value: "new-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-gemini" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());

    const payload = submit.mock.calls[0][0];
    const settings = JSON.parse(payload.settingsConfig);
    expect(settings.env.GOOGLE_CLOUD_PROJECT).toBe("new-project");
    expect(settings.env.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
    expect(payload.meta.vertexAi).toEqual({
      projectId: "new-project",
      location: "global",
      publisher: "google",
    });
  });
});
