import assert from "node:assert/strict";
import test from "node:test";
import { autoStubModule, collectElements, createModuleGraph, elementProps } from "./helpers/jsx-tree.mjs";

test("默认推理强度仅提供模型支持档位，并允许恢复默认", () => {
  const graph = createModuleGraph(new URL("../src/components/ModelSettingsFields.tsx", import.meta.url), {
    stubs: {
      "@heroui/react": autoStubModule("heroui"),
      "@tabler/icons-react": autoStubModule("icons"),
      "./ui": autoStubModule("ui"),
    },
  });
  const changes = [];
  const tree = graph.exports.ModelSettingsFields({
    model: "gpt-test", disabled: false, onChange() {},
    defaultReasoning: { value: "high", supportedLevels: ["low", "high"], onChange: (value) => changes.push(value) },
  });
  const control = elementProps(collectElements(tree, (node) => elementProps(node)?.["aria-label"] === "gpt-test 默认推理强度")[0]);
  assert.deepEqual(control.optionList.map((option) => option.value), ["auto", "low", "high"]);
  assert.equal(control.value, "high");
  control.onChange("low");
  control.onChange("auto");
  assert.deepEqual(changes, ["low", ""]);
});

for (const official of [true, false]) {
  test(`${official ? "官方" : "第三方"}线路回填、保存与清除默认推理强度`, async () => {
    const calls = [];
    const model = "gpt-test";
    const config = {
      activeProfileId: "route", localRouterEnabled: true,
      profiles: [{ id: "route", sourceProviderId: "provider", authMode: official ? "officialAccount" : "apiKey" }],
      selectedModelsByProvider: { provider: [model] },
      modelDefaultReasoningEffortsByProvider: { provider: { "GPT-TEST": "high", removed: "low" } },
    };
    const graph = createModuleGraph(new URL("../src/useModelSelection.ts", import.meta.url), {
      stubs: {
        "./subagentModels": { buildSubagentModelOptions: () => [] },
        "./api": { invoke: async (command, payload) => { calls.push({ command, payload }); return {}; } },
      },
    });
    const render = () => {
      graph.restart();
      return graph.exports.useModelSelection({
        config, currentProvider: { id: "provider", official }, officialAccountAvailable: official,
        runOperation: async (_name, operation) => operation(), applyConfigResult: () => false, setNotice() {},
      });
    };
    render().openModelPicker({
      officialModels: official ? [{ slug: model, supported: true, supportedReasoningEfforts: ["low", "high"] }] : [],
      officialModelIds: official ? [model] : [], thirdPartyModels: official ? [] : [model],
      manualThirdPartyModels: [], upstreamModels: official ? [] : [model], defaultModel: model,
    }, "", "route");
    assert.equal(render().draftModelDefaultReasoningEfforts[model], "high");
    render().updateDraftModelDefaultReasoningEffort(model, "low");
    await render().saveModelSelection();
    assert.equal(calls[0].command, official ? "save_official_route_models" : "save_selected_models");
    assert.deepEqual(calls[0].payload.modelDefaultReasoningEfforts, { [model]: "low" });
    render().updateDraftModelDefaultReasoningEffort(model, "");
    await render().saveModelSelection();
    assert.deepEqual(calls[1].payload.modelDefaultReasoningEfforts, {});
    if (!official) {
      render().updateDraftModelDefaultReasoningEffort(model, "high");
      render().updateDraftReasoningEffort(model, [{ level: "low", value: "low" }]);
      assert.equal(render().draftModelDefaultReasoningEfforts[model], undefined);
      render().updateDraftModelDefaultReasoningEffort(model, "low");
      render().updateDraftReasoningEffort(model, [{ level: "low", value: "low" }]);
      assert.equal(render().draftModelDefaultReasoningEfforts[model], "low");
      render().updateDraftModelDefaultReasoningEffort(model, "ultra");
      render().resetDraftReasoningEffort(model);
      assert.equal(render().draftModelDefaultReasoningEfforts[model], undefined);
    }
  });
}

for (const capability of [undefined, ["low", "high"]]) {
  test(`新增自定义模型立即初始化${capability ? "插件声明" : "通用"}推理档位`, () => {
    const model = "custom-model";
    const graph = createModuleGraph(new URL("../src/useModelSelection.ts", import.meta.url), {
      stubs: { "./subagentModels": { buildSubagentModelOptions: () => [] }, "./api": { invoke() {} } },
    });
    const render = () => {
      graph.restart();
      return graph.exports.useModelSelection({
        config: {
          activeProfileId: "route", localRouterEnabled: true,
          profiles: [{ id: "route", sourceProviderId: "provider", authMode: "apiKey",
            ...(capability ? { pluginOwnerId: "plugin", pluginRouteSpec: { modelReasoningEfforts: { [model]: capability } } } : {}),
          }], selectedModelsByProvider: { provider: [] },
        },
        currentProvider: { id: "provider", official: false }, officialAccountAvailable: false,
        runOperation: async (_name, operation) => operation(), applyConfigResult: () => false, setNotice() {},
      });
    };
    render().openModelPicker({ officialModels: [], officialModelIds: [], thirdPartyModels: [],
      manualThirdPartyModels: [], upstreamModels: [], defaultModel: "" }, "", "route");
    render().updateCustomModelInput(model);
    render().addCustomModel();
    const expected = capability ?? ["low", "medium", "high", "xhigh"];
    assert.deepEqual(render().draftReasoningEfforts[model].map((effort) => effort.level), expected);
    assert.deepEqual(render().reasoningEffortAutoByModel[model].map((effort) => effort.level), expected);
  });
}
