import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeDesktopProviderForm } from "@/components/providers/forms/ClaudeDesktopProviderForm";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { createTestQueryClient } from "../utils/testQueryClient";
import { providersApi } from "@/lib/api/providers";
import type { Provider } from "@/types";

const authState = vi.hoisted(() => ({
  codexReauthRequired: false,
}));
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));
const modelFetchMocks = vi.hoisted(() => ({
  fetchCodexOauthModels: vi.fn(),
  fetchVertexModels: vi.fn(),
}));

vi.mock("@/lib/api/model-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/model-fetch")>();
  return {
    ...actual,
    fetchCodexOauthModels: modelFetchMocks.fetchCodexOauthModels,
    fetchVertexModels: modelFetchMocks.fetchVertexModels,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: toastMocks.error,
    success: vi.fn(),
  },
}));

vi.mock("@/components/providers/forms/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/forms/hooks")>();
  return {
    ...actual,
    useCopilotAuth: () => ({
      isAuthenticated: false,
      accounts: [],
    }),
    useCodexOauth: () => ({
      isAuthenticated: true,
      defaultAccountId: "acct-managed",
      accounts: [
        {
          id: "acct-managed",
          is_default: true,
          reauth_required: authState.codexReauthRequired,
          requires_reauth: false,
        },
      ],
    }),
    useXaiOauth: () => ({
      isAuthenticated: false,
      accounts: [],
    }),
  };
});

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: () => <div data-testid="codex-oauth-section" />,
}));

vi.mock("@/components/providers/forms/CopilotAuthSection", () => ({
  CopilotAuthSection: () => <div data-testid="copilot-auth-section" />,
}));

vi.mock("@/components/providers/forms/XaiOAuthSection", () => ({
  XaiOAuthSection: () => <div data-testid="xai-oauth-section" />,
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getClaudeDesktopDefaultRoutes: () => Promise.resolve([]),
    importVertexServiceAccount: vi.fn(),
    getAll: vi.fn(),
  },
}));

function renderForm(
  initialData: ComponentProps<typeof ClaudeDesktopProviderForm>["initialData"],
  onSubmit = vi.fn(),
) {
  const queryClient = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ClaudeDesktopProviderForm
        submitLabel="保存"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={initialData}
      />
    </QueryClientProvider>,
  );
  return { ...view, onSubmit };
}

describe("ClaudeDesktopProviderForm", () => {
  beforeEach(() => {
    authState.codexReauthRequired = false;
    toastMocks.error.mockReset();
    modelFetchMocks.fetchCodexOauthModels.mockReset();
    modelFetchMocks.fetchVertexModels.mockReset();
    vi.mocked(providersApi.getAll).mockResolvedValue({});
  });

  it("托管 OAuth 供应商也能获取模型并在映射行里选择（#8426）", async () => {
    modelFetchMocks.fetchCodexOauthModels.mockResolvedValue([
      { id: "gpt-5.6", ownedBy: "openai" },
    ]);
    renderForm({
      name: "Codex OAuth Provider",
      category: "third_party",
      settingsConfig: { env: {} },
      meta: {
        providerType: "codex_oauth",
        authBinding: {
          source: "managed_account",
          authProvider: "codex_oauth",
          accountId: "acct-managed",
        },
        claudeDesktopMode: "proxy",
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: "upstream-model" },
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /获取模型/ }));

    await waitFor(() =>
      expect(modelFetchMocks.fetchCodexOauthModels).toHaveBeenCalledWith(
        "acct-managed",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Select model" }).length,
      ).toBeGreaterThan(0),
    );
  });

  it("未登录的 Copilot 获取模型时提示先登录", async () => {
    renderForm({
      name: "Copilot Provider",
      category: "third_party",
      settingsConfig: { env: {} },
      meta: {
        providerType: "github_copilot",
        claudeDesktopMode: "proxy",
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: "claude-sonnet-5" },
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /获取模型/ }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("请先登录 GitHub Copilot"),
    );
  });

  it.each(["github_copilot", "codex_oauth", "xai_oauth"])(
    "托管 OAuth %s 即使旧数据是 direct 也强制开启模型映射",
    (providerType) => {
      renderForm({
        name: "Managed OAuth Provider",
        category: "third_party",
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com",
          },
        },
        meta: {
          providerType,
          claudeDesktopMode: "direct",
          apiFormat: "anthropic",
          claudeDesktopModelRoutes: {
            "claude-sonnet-5": { model: "upstream-model" },
          },
        },
      });

      const modelModePicker = screen.getByRole("combobox", {
        name: "接入方式",
      });
      expect(modelModePicker).toHaveTextContent("模型映射");
      expect(modelModePicker).toBeDisabled();
      if (providerType === "github_copilot") {
        const formatControl = screen
          .getByText("copilot.automaticFormat")
          .closest("button");
        expect(formatControl).toBeDisabled();
        expect(screen.getByText(/copilot.automaticFormatHint/)).toBeVisible();
      }
    },
  );

  it.each(["codex_oauth", "xai_oauth"])(
    "%s 忽略 Copilot 地址并保留自身协议与认证方式",
    (providerType) => {
      renderForm({
        name: "Managed OAuth Provider",
        settingsConfig: {
          env: { ANTHROPIC_BASE_URL: "https://api.githubcopilot.com" },
        },
        meta: {
          providerType,
          claudeDesktopMode: "proxy",
          apiFormat: "openai_responses",
        },
      });

      expect(
        screen.queryByText("copilot.automaticFormat"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("copilot.automaticFormatHint"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("copilot-auth-section"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId(
          providerType === "codex_oauth"
            ? "codex-oauth-section"
            : "xai-oauth-section",
        ),
      ).toBeVisible();
      if (providerType === "codex_oauth") {
        expect(
          screen
            .getAllByRole("combobox")
            .find((control) =>
              control.textContent?.includes(
                "OpenAI Responses API (需开启路由)",
              ),
            ),
        ).toBeEnabled();
      }
    },
  );

  it.each([
    "anthropic",
    "openai_chat",
    "openai_responses",
    "gemini_native",
  ] as const)("手动配置 Copilot 地址时禁用旧格式 %s 的手选", (apiFormat) => {
    renderForm({
      name: "Custom Copilot",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.githubcopilot.com",
          ANTHROPIC_AUTH_TOKEN: "test-token",
        },
      },
      meta: { claudeDesktopMode: "proxy", apiFormat },
    });

    expect(
      screen.getByText("copilot.automaticFormat").closest("button"),
    ).toBeDisabled();
    expect(screen.getByText("copilot.automaticFormatHint")).toBeVisible();
    expect(screen.getByLabelText("API Key")).toBeVisible();
    expect(
      screen.queryByTestId("copilot-auth-section"),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "https://api.githubcopilot.com",
      "https://api.githubcopilot.com",
      "anthropic",
    ],
    ["https://api.example.com", "https://api.githubcopilot.com", "anthropic"],
    [
      "https://api.githubcopilot.com",
      "https://api.example.com",
      "gemini_native",
    ],
    ["https://api.example.com", "https://api.example.com", "gemini_native"],
  ])(
    "遗留 Gemini 格式从 %s 编辑为 %s 后保存为 %s",
    async (initialUrl, finalUrl, expectedFormat) => {
      const { onSubmit } = renderForm({
        name: "Legacy Gemini Provider",
        settingsConfig: {
          api_format: "gemini_native",
          env: {
            ANTHROPIC_BASE_URL: initialUrl,
            ANTHROPIC_AUTH_TOKEN: "test-token",
          },
        },
        meta: {
          claudeDesktopMode: "proxy",
          apiFormat: "gemini_native",
          claudeDesktopModelRoutes: {
            "claude-sonnet-5": { model: "upstream-model" },
          },
        },
      });

      fireEvent.change(screen.getByLabelText("providerForm.apiEndpoint"), {
        target: { value: finalUrl },
      });
      if (finalUrl.includes("githubcopilot.com")) {
        expect(
          screen.getByText("copilot.automaticFormat").closest("button"),
        ).toBeDisabled();
      }
      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const values = onSubmit.mock.calls[0][0];
      expect(values.meta.apiFormat).toBe(expectedFormat);
      expect(values.meta.providerType).toBeUndefined();
      expect(values.meta.authBinding).toBeUndefined();
      expect(JSON.parse(values.settingsConfig).env).toMatchObject({
        ANTHROPIC_BASE_URL: finalUrl,
        ANTHROPIC_AUTH_TOKEN: "test-token",
      });
    },
  );

  it("修改自定义上游地址时同步切换自动格式并保留原格式", async () => {
    renderForm({
      name: "Custom Provider",
      settingsConfig: {
        env: { ANTHROPIC_BASE_URL: "https://api.example.com" },
      },
      meta: { claudeDesktopMode: "proxy", apiFormat: "openai_chat" },
    });

    const formatControl = screen
      .getAllByRole("combobox")
      .find((control) =>
        control.textContent?.includes("OpenAI Chat Completions (需开启路由)"),
      );
    expect(formatControl).toBeEnabled();
    expect(
      screen.queryByText("copilot.automaticFormatHint"),
    ).not.toBeInTheDocument();

    const endpoint = screen.getByLabelText("providerForm.apiEndpoint");
    fireEvent.change(endpoint, {
      target: { value: "https://api.business.githubcopilot.com" },
    });
    expect(formatControl).toBeDisabled();
    await waitFor(() =>
      expect(formatControl).toHaveTextContent("copilot.automaticFormat"),
    );
    expect(screen.getByText("copilot.automaticFormatHint")).toBeVisible();

    fireEvent.change(endpoint, {
      target: { value: "https://api.example.com" },
    });
    expect(formatControl).toBeEnabled();
    expect(formatControl).toHaveTextContent(
      "OpenAI Chat Completions (需开启路由)",
    );
    expect(
      screen.queryByText("copilot.automaticFormatHint"),
    ).not.toBeInTheDocument();
  });

  it("新建自定义供应商默认使用直连并显示模型列表", () => {
    renderForm(undefined);

    expect(
      screen.getByRole("combobox", { name: "接入方式" }),
    ).toHaveTextContent("直连");
    expect(screen.getByText("模型列表")).toBeInTheDocument();
    expect(screen.queryByText("模型角色")).not.toBeInTheDocument();
  });

  it("直连预设保留预设模型列表", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm(undefined, onSubmit);

    await user.click(screen.getByRole("button", { name: /PackyCode/ }));

    expect(screen.getByDisplayValue("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("claude-haiku-4-5")).toBeInTheDocument();

    await user.clear(screen.getByDisplayValue("claude-sonnet-5"));
    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(
      onSubmit.mock.calls[0][0].meta.claudeDesktopModelRoutes,
    ).toMatchObject({
      "claude-opus-5": { model: "claude-opus-5" },
      "claude-haiku-4-5": { model: "claude-haiku-4-5" },
    });
    expect(
      onSubmit.mock.calls[0][0].meta.claudeDesktopModelRoutes,
    ).not.toHaveProperty("claude-sonnet-5");
  });

  it("直连与模型映射分别保留自己的模型列表", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    renderForm({
      name: "Proxy Provider",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-test",
        },
      },
      meta: {
        claudeDesktopMode: "proxy",
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": {
            model: "upstream-sonnet",
          },
        },
      },
    });

    expect(screen.getByDisplayValue("upstream-sonnet")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "接入方式" }));
    await user.click(await screen.findByRole("option", { name: "直连" }));

    expect(screen.getByText("模型列表")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("claude-sonnet-4-6"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("claude-sonnet-5"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "接入方式" }));
    await user.click(await screen.findByRole("option", { name: "模型映射" }));

    expect(screen.getByDisplayValue("upstream-sonnet")).toBeInTheDocument();
  });

  it("编辑模型映射的菜单显示名时保持输入框焦点", () => {
    renderForm({
      name: "Proxy Provider",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-test",
        },
      },
      meta: {
        claudeDesktopMode: "proxy",
        claudeDesktopModelRoutes: {
          "claude-old": {
            model: "upstream-old",
          },
        },
      },
    });

    // 固定四档（Sonnet / Opus / Fable / Haiku）下有四个菜单显示名输入，取 Sonnet（首个）。
    const input = screen.getAllByPlaceholderText(
      "DeepSeek V4 Pro",
    )[0] as HTMLInputElement;
    input.focus();

    fireEvent.change(input, { target: { value: "DeepSeek V4 Pro" } });

    const currentInput = screen.getAllByPlaceholderText(
      "DeepSeek V4 Pro",
    )[0] as HTMLInputElement;
    expect(currentInput).toHaveValue("DeepSeek V4 Pro");
    expect(document.activeElement).toBe(currentInput);
  });

  it("编辑直连模型列表的模型 ID 时保持输入框焦点", () => {
    renderForm({
      name: "Direct Provider",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-test",
        },
      },
      meta: {
        claudeDesktopMode: "direct",
        claudeDesktopModelRoutes: {
          "claude-old": {
            model: "claude-old",
          },
        },
      },
    });

    const input = screen.getByPlaceholderText(
      "claude-sonnet-4-6",
    ) as HTMLInputElement;
    input.focus();

    fireEvent.change(input, { target: { value: "claude-12345" } });

    const currentInput = screen.getByPlaceholderText(
      "claude-sonnet-4-6",
    ) as HTMLInputElement;
    expect(currentInput).toHaveValue("claude-12345");
    expect(document.activeElement).toBe(currentInput);
  });

  it("代理模式始终渲染 Sonnet / Opus / Fable / Haiku 四档（即使只配了一档）", () => {
    renderForm({
      name: "Proxy Provider",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-test",
        },
      },
      meta: {
        claudeDesktopMode: "proxy",
        claudeDesktopModelRoutes: {
          "claude-sonnet-4-6": { model: "upstream-sonnet" },
        },
      },
    });

    // 固定四档：每档各一个「菜单显示名」输入框，无论初始只配了几档。
    // Haiku 档的占位示例是 "DeepSeek V4 Flash"、其余三档是 "DeepSeek V4 Pro"
    // （见组件的 role-consistent 占位逻辑），故用正则同时匹配两种占位、数满四档。
    expect(
      screen.getAllByPlaceholderText(/DeepSeek V4 (Pro|Flash)/),
    ).toHaveLength(4);
  });

  it("代理模式初始无路由且默认路由未就绪时不渲染空四档", () => {
    // mock 的 getClaudeDesktopDefaultRoutes 返回 []，模拟默认路由尚未就绪。
    // 修复前：normalizeProxyRows([]) 会渲染空行并把 routes.length 撑起来，
    // 永久挡住 seed effect 的默认路由回填。修复后应保持空、等待 seed。
    renderForm({
      name: "Proxy Provider",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-test",
        },
      },
      meta: {
        claudeDesktopMode: "proxy",
        claudeDesktopModelRoutes: {},
      },
    });

    expect(screen.queryAllByPlaceholderText("DeepSeek V4 Pro")).toHaveLength(0);
  });

  it("保存模型映射时补齐固定四档并把留空档回填为 Sonnet 模型", async () => {
    const onSubmit = vi.fn();
    renderForm(
      {
        name: "Proxy Provider",
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com",
            ANTHROPIC_AUTH_TOKEN: "sk-test",
          },
        },
        meta: {
          claudeDesktopMode: "proxy",
          claudeDesktopModelRoutes: {
            "claude-old": {
              model: "upstream-old",
            },
          },
        },
      },
      onSubmit,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    // claude-old 迁移到 Sonnet；留空的 Opus / Fable / Haiku 回填为 Sonnet 的
    // 上游模型，保证落库四档齐全，子 agent 调用的各档始终可解析。
    expect(submitted.meta.claudeDesktopModelRoutes).toMatchObject({
      "claude-sonnet-5": {
        model: "upstream-old",
        labelOverride: "upstream-old",
      },
      "claude-opus-5": { model: "upstream-old" },
      "claude-fable-5": { model: "upstream-old" },
      "claude-haiku-4-5": { model: "upstream-old" },
    });
    expect(Object.keys(submitted.meta.claudeDesktopModelRoutes).sort()).toEqual(
      [
        "claude-fable-5",
        "claude-haiku-4-5",
        "claude-opus-5",
        "claude-sonnet-5",
      ],
    );
  });

  it("回填空档时继承 Sonnet 的 1M 声明", async () => {
    const onSubmit = vi.fn();
    renderForm(
      {
        name: "Proxy Provider",
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com",
            ANTHROPIC_AUTH_TOKEN: "sk-test",
          },
        },
        meta: {
          claudeDesktopMode: "proxy",
          claudeDesktopModelRoutes: {
            "claude-sonnet-4-6": { model: "deepseek-v4-pro", supports1m: true },
          },
        },
      },
      onSubmit,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const routes = onSubmit.mock.calls[0][0].meta.claudeDesktopModelRoutes;
    // 留空的 Opus / Haiku 回填同一上游模型，1M 声明应与 Sonnet 一致。
    expect(routes["claude-sonnet-5"]).toMatchObject({
      model: "deepseek-v4-pro",
      supports1m: true,
    });
    expect(routes["claude-opus-5"]).toMatchObject({
      model: "deepseek-v4-pro",
      supports1m: true,
    });
    expect(routes["claude-haiku-4-5"]).toMatchObject({
      model: "deepseek-v4-pro",
      supports1m: true,
    });
  });

  it("保存直连模型列表时不会保留旧 route 作为隐藏映射目标", async () => {
    const onSubmit = vi.fn();
    renderForm(
      {
        name: "Direct Provider",
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com",
            ANTHROPIC_AUTH_TOKEN: "sk-test",
          },
        },
        meta: {
          claudeDesktopMode: "direct",
          claudeDesktopModelRoutes: {
            "claude-old": {
              model: "claude-old",
            },
          },
        },
      },
      onSubmit,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.meta.claudeDesktopModelRoutes).toMatchObject({
      "claude-sonnet-5": {
        model: "claude-sonnet-5",
      },
    });
  });

  it("不允许保存需要重新登录的 Codex OAuth 账号", async () => {
    authState.codexReauthRequired = true;
    const onSubmit = vi.fn();
    renderForm(
      {
        name: "Codex OAuth Provider",
        category: "third_party",
        settingsConfig: { env: {} },
        meta: {
          providerType: "codex_oauth",
          authBinding: {
            source: "managed_account",
            authProvider: "codex_oauth",
            accountId: "acct-managed",
          },
          claudeDesktopMode: "proxy",
          claudeDesktopModelRoutes: {
            "claude-sonnet-5": { model: "upstream-model" },
          },
        },
      },
      onSubmit,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "已绑定账号不存在或需要重新登录，请重新选择账号",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("未选择账号时不允许保存需要重新登录的 Codex OAuth 默认账号", async () => {
    authState.codexReauthRequired = true;
    const onSubmit = vi.fn();
    renderForm(
      {
        name: "Codex OAuth Default Account Provider",
        category: "third_party",
        settingsConfig: { env: {} },
        meta: {
          providerType: "codex_oauth",
          claudeDesktopMode: "proxy",
          claudeDesktopModelRoutes: {
            "claude-sonnet-5": { model: "upstream-model" },
          },
        },
      },
      onSubmit,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "已绑定账号不存在或需要重新登录，请重新选择账号",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ClaudeDesktopProviderForm Vertex AI", () => {
  it("saves a proxied Vertex provider with project and location", async () => {
    const { onSubmit } = renderForm({
      name: "Google Vertex AI",
      category: "cloud_provider",
      settingsConfig: {
        env: { ANTHROPIC_BASE_URL: "https://aiplatform.googleapis.com" },
      },
      meta: {
        claudeDesktopMode: "proxy",
        apiFormat: "anthropic",
        vertexAi: {
          projectId: "my-project",
          location: "global",
          publisher: "anthropic",
        },
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: "claude-sonnet-5", supports1m: true },
          "claude-opus-5": { model: "claude-opus-5", supports1m: true },
          "claude-haiku-4-5": { model: "claude-haiku-4-5" },
        },
      },
    });

    expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue(
      "my-project",
    );
    expect(screen.getByLabelText("vertexAi.location")).toHaveValue("global");

    fireEvent.change(screen.getByLabelText("vertexAi.projectId"), {
      target: { value: "new-project" },
    });
    fireEvent.change(screen.getByLabelText("vertexAi.location"), {
      target: { value: "us-east5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.meta.claudeDesktopMode).toBe("proxy");
    expect(payload.meta.apiFormat).toBe("anthropic");
    expect(payload.meta.vertexAi).toEqual({
      projectId: "new-project",
      location: "us-east5",
      publisher: "anthropic",
    });
    const settings = JSON.parse(payload.settingsConfig);
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(
      "https://aiplatform.googleapis.com",
    );
    expect(settings.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(settings.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});

beforeEach(() => {
  vi.mocked(providersApi.getAll).mockResolvedValue({});
  vi.mocked(providersApi.importVertexServiceAccount).mockReset();
  modelFetchMocks.fetchVertexModels.mockReset();
});

describe("Claude Desktop Vertex credential reuse", () => {
  it("reuses a service account already stored in another app", async () => {
    const serviceAccount = {
      type: "service_account" as const,
      project_id: "stored-project",
      private_key_id: "stored-id",
      private_key: "fixture-private-key",
      client_email: "stored@stored-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    vi.mocked(providersApi.getAll).mockImplementation(
      async (app): Promise<Record<string, Provider>> => {
        if (app !== "codex") return {};
        return {
          "codex-vertex": {
            id: "codex-vertex",
            name: "Google Vertex AI",
            settingsConfig: {},
            meta: {
              vertexAi: {
                projectId: "stored-project",
                location: "global",
                publisher: "anthropic",
                serviceAccount,
              },
            },
          },
        };
      },
    );

    renderForm({
      name: "Google Vertex AI",
      category: "cloud_provider",
      settingsConfig: {
        env: { ANTHROPIC_BASE_URL: "https://aiplatform.googleapis.com" },
      },
      meta: {
        claudeDesktopMode: "proxy",
        apiFormat: "anthropic",
        vertexAi: {
          projectId: "",
          location: "global",
          publisher: "anthropic",
        },
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: "claude-sonnet-5", supports1m: true },
          "claude-opus-5": { model: "claude-opus-5", supports1m: true },
          "claude-haiku-4-5": { model: "claude-haiku-4-5" },
        },
      },
    });

    await screen.findByText(serviceAccount.client_email);
    expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue(
      "stored-project",
    );
    expect(providersApi.getAll).toHaveBeenCalledWith("codex");
  });
});

describe("Claude Desktop Vertex model family", () => {
  it("switches the mapping and fetch publisher to Gemini", async () => {
    const { onSubmit } = renderForm({
      name: "Google Vertex AI",
      category: "cloud_provider",
      settingsConfig: {
        env: { ANTHROPIC_BASE_URL: "https://aiplatform.googleapis.com" },
      },
      meta: {
        claudeDesktopMode: "proxy",
        apiFormat: "anthropic",
        vertexAi: {
          projectId: "my-project",
          location: "global",
          publisher: "anthropic",
        },
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: "claude-sonnet-5", supports1m: true },
          "claude-opus-5": { model: "claude-opus-5", supports1m: true },
          "claude-haiku-4-5": { model: "claude-haiku-4-5" },
        },
      },
    });

    expect(
      screen.getByRole("button", { name: "Claude" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Gemini" }));
    expect(
      screen.getByRole("button", { name: "Gemini" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/当前：Gemini/)).toBeInTheDocument();
    expect(
      screen.getAllByDisplayValue("gemini-4-argon").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByDisplayValue("gemini-3.8-flash").length,
    ).toBeGreaterThan(0);

    modelFetchMocks.fetchVertexModels.mockResolvedValue([
      { id: "gemini-4-argon", ownedBy: "google" },
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: /获取模型/ })[0]);
    await waitFor(() =>
      expect(modelFetchMocks.fetchVertexModels).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "my-project",
          location: "global",
          publisher: "google",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].meta.apiFormat).toBe("gemini_native");
    expect(onSubmit.mock.calls[0][0].meta.vertexAi.publisher).toBe("google");
  });
});

describe("Claude Desktop Vertex service account import", () => {
  it("fills the project ID from the imported JSON key", async () => {
    const serviceAccount = {
      type: "service_account" as const,
      project_id: "key-project",
      private_key_id: "test-id",
      private_key: "fixture-private-key",
      client_email: "test@key-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    vi.mocked(providersApi.importVertexServiceAccount).mockResolvedValue(
      serviceAccount,
    );

    const { onSubmit } = renderForm({
      name: "Google Vertex AI",
      category: "cloud_provider",
      settingsConfig: {
        env: { ANTHROPIC_BASE_URL: "https://aiplatform.googleapis.com" },
      },
      meta: {
        claudeDesktopMode: "proxy",
        apiFormat: "anthropic",
        vertexAi: {
          projectId: "",
          location: "global",
          publisher: "anthropic",
        },
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: "claude-sonnet-5", supports1m: true },
          "claude-opus-5": { model: "claude-opus-5", supports1m: true },
          "claude-haiku-4-5": { model: "claude-haiku-4-5" },
        },
      },
    });

    fireEvent.change(screen.getByLabelText("vertexAi.serviceAccount"), {
      target: {
        files: [
          new File([JSON.stringify(serviceAccount)], "key.json", {
            type: "application/json",
          }),
        ],
      },
    });
    await screen.findByText(serviceAccount.client_email);
    expect(providersApi.importVertexServiceAccount).toHaveBeenCalledWith(
      JSON.stringify(serviceAccount),
    );
    expect(screen.getByLabelText("vertexAi.projectId")).toHaveValue(
      "key-project",
    );

    modelFetchMocks.fetchVertexModels.mockResolvedValue([
      { id: "claude-sonnet-5", ownedBy: "anthropic" },
    ]);
    fireEvent.click(
      screen.getAllByRole("button", { name: /获取模型/ })[0],
    );
    await waitFor(() =>
      expect(modelFetchMocks.fetchVertexModels).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "key-project",
          location: "global",
          publisher: "anthropic",
          serviceAccount,
        }),
      ),
    );

    Element.prototype.scrollIntoView = vi.fn();
    const dropdownButtons = screen.getAllByRole("button", {
      name: "Select model",
    });
    expect(dropdownButtons.length).toBeGreaterThan(0);
    fireEvent.click(dropdownButtons[0]);
    const option = screen.getByRole("option", { name: "claude-sonnet-5" });
    await waitFor(() => expect(option).toBeVisible());
    fireEvent.click(option);
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "claude-sonnet-5" })).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.meta.vertexAi).toMatchObject({
      projectId: "key-project",
      serviceAccount,
    });
  });
});

describe("Claude Desktop Vertex preset", () => {
  it("is available as a proxied cloud provider", () => {
    const preset = claudeDesktopProviderPresets.find(
      (item) => item.name === "Google Vertex AI",
    );
    expect(preset).toBeDefined();
    expect(preset?.category).toBe("cloud_provider");
    expect(preset?.mode).toBe("proxy");
    expect(preset?.vertexAi).toEqual({
      projectId: "",
      location: "global",
      publisher: "anthropic",
    });

    const gemini = claudeDesktopProviderPresets.find(
      (item) => item.name === "Google Vertex AI (Gemini)",
    );
    expect(gemini).toBeDefined();
    expect(gemini?.category).toBe("cloud_provider");
    expect(gemini?.mode).toBe("proxy");
    expect(gemini?.apiFormat).toBe("gemini_native");
    expect(gemini?.vertexAi).toEqual({
      projectId: "",
      location: "global",
      publisher: "google",
    });
    expect(
      gemini?.modelRoutes?.map((route) => route.upstreamModel),
    ).toContain("gemini-4-argon");
  });
});
