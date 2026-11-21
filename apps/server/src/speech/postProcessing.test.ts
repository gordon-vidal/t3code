import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";

const textGenerationSelection = {
  instanceId: ProviderInstanceId.make("fakeapi"),
  model: "fake-model",
};
const acpSelection = { instanceId: ProviderInstanceId.make("acp_local"), model: "default" };

const emptyStoresLayer = Layer.mergeAll(
  Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({
    getThreadSpeechContext: () => Effect.succeed(null),
  }),
  Layer.mock(ProjectStoreV2.ProjectStoreV2)({
    get: () => Effect.succeedNone,
  }),
);

it.effect("cleanup pinned to a provider that cannot generate text uses the text model", () =>
  Effect.gen(function* () {
    const used = yield* Ref.make<ModelSelection | null>(null);
    const layer = SpeechPostProcessing.layer.pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: (input: { modelSelection: ModelSelection }) =>
            Ref.set(used, input.modelSelection).pipe(Effect.as({ transcription: "Hello, world." })),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: acpSelection.instanceId,
              driver: "acpRegistry",
              enabled: true,
              installed: true,
              supportsTextGeneration: false,
            },
          ]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [acpSelection.instanceId]: {
              driver: "acpRegistry",
              enabled: true,
              config: { source: "local", commandPath: "acp-agent" },
            },
          },
          textGenerators: {
            [textGenerationSelection.instanceId]: {
              kind: "openaiCompatible",
              baseUrl: "http://127.0.0.1:18999/v1",
              enabled: true,
            },
          },
          textGenerationModelSelection: textGenerationSelection,
          speechPostProcessingModelSelection: acpSelection,
        }),
      ),
      Layer.provide(emptyStoresLayer),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
      yield* postProcessing.process({
        options: {
          speechCustomWords: [],
          speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
        },
        transcript: "um hello world",
        draft: { text: "", selection: { start: 0, end: 0 } },
      } as never);
    }).pipe(Effect.provide(layer));
    const selection = yield* Ref.get(used);
    assert.deepStrictEqual(
      { instanceId: selection?.instanceId, model: selection?.model },
      textGenerationSelection,
    );
  }),
);

it.effect(
  "includes thread vocabulary from projection and project stores when threadId is set",
  () =>
    Effect.gen(function* () {
      const capturedPrompt = yield* Ref.make<string>("");
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      const layer = SpeechPostProcessing.layer.pipe(
        Layer.provide(
          Layer.succeed(TextGeneration.TextGeneration, {
            generateTranscriptionPostProcessing: (input: { prompt: string }) =>
              Ref.set(capturedPrompt, input.prompt).pipe(
                Effect.as({ transcription: "In postProcessing.ts, read ProjectionStoreV2." }),
              ),
          } as unknown as TextGeneration.TextGeneration["Service"]),
        ),
        Layer.provide(
          Layer.succeed(ProviderRegistry.ProviderRegistry, {
            getProviders: Effect.succeed([]),
          } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        ),
        Layer.provide(
          ServerSettings.layerTest({
            textGenerators: {
              [textGenerationSelection.instanceId]: {
                kind: "openaiCompatible",
                baseUrl: "http://127.0.0.1:18999/v1",
                enabled: true,
              },
            },
            textGenerationModelSelection: textGenerationSelection,
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({
              getThreadSpeechContext: (id) =>
                Effect.succeed(
                  id === threadId
                    ? {
                        projectId,
                        threadTitle: "Voice cleanup live context",
                        branch: "feat/voice-cleanup-thread-context",
                        messages: [
                          {
                            role: "assistant",
                            text: "Updated `ProjectionStoreV2` and `vp run check:changed`.",
                          },
                        ],
                        checkpoints: [
                          {
                            files: [
                              {
                                path: "apps/server/src/speech/postProcessing.ts" as never,
                                kind: "modified",
                                additions: 10,
                                deletions: 2,
                              },
                            ],
                          },
                        ],
                      }
                    : null,
                ),
            }),
            Layer.mock(ProjectStoreV2.ProjectStoreV2)({
              get: (id) =>
                Effect.succeed(
                  id === projectId ? Option.some({ title: "t3code" } as never) : Option.none(),
                ),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
        yield* postProcessing.process({
          options: {
            speechCustomWords: [],
            speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
          },
          transcript: "in post processing dot ts read projection store v2",
          draft: { text: "", selection: { start: 0, end: 0 } },
          threadId,
        } as never);
      }).pipe(Effect.provide(layer));

      const prompt = yield* Ref.get(capturedPrompt);
      assert.include(prompt, "<thread_context>");
      assert.include(prompt, '"project": "t3code"');
      assert.include(prompt, '"thread": "Voice cleanup live context"');
      assert.include(prompt, '"branch": "feat/voice-cleanup-thread-context"');
      assert.include(prompt, "apps/server/src/speech/postProcessing.ts");
      assert.include(prompt, "ProjectionStoreV2");
      assert.include(prompt, "vp run check:changed");
    }),
);
