import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentSpeechPostProcessingRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";

import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";
import {
  extractCheckpointFiles,
  extractThreadTerms,
  SPEECH_CONTEXT_CHECKPOINT_LIMIT,
  SPEECH_CONTEXT_MESSAGE_LIMIT,
  type TranscriptionLiveContext,
} from "./liveContext.ts";
import { SpeechOperationError } from "./SpeechService.ts";

export class SpeechPostProcessing extends Context.Service<
  SpeechPostProcessing,
  {
    readonly process: (
      input: EnvironmentSpeechPostProcessingRequest,
    ) => Effect.Effect<{ readonly text: string }, SpeechOperationError>;
  }
>()("t3/speech/postProcessing/SpeechPostProcessing") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
  const projectStore = yield* ProjectStoreV2.ProjectStoreV2;

  const loadLiveContext = (
    threadId: EnvironmentSpeechPostProcessingRequest["threadId"],
  ): Effect.Effect<TranscriptionLiveContext | undefined> => {
    if (!threadId) return Effect.undefined;
    return Effect.gen(function* () {
      const threadContext = yield* projectionStore.getThreadSpeechContext(threadId, {
        messageLimit: SPEECH_CONTEXT_MESSAGE_LIMIT,
        checkpointLimit: SPEECH_CONTEXT_CHECKPOINT_LIMIT,
      });
      if (!threadContext) return undefined;
      const projectTitle = yield* projectStore.get(threadContext.projectId).pipe(
        Effect.map((project) => (Option.isSome(project) ? project.value.title : undefined)),
        Effect.orElseSucceed(() => undefined),
      );
      return {
        projectTitle,
        threadTitle: threadContext.threadTitle,
        branch: threadContext.branch ?? undefined,
        files: extractCheckpointFiles(threadContext.checkpoints),
        terms: extractThreadTerms(threadContext.messages),
      };
    }).pipe(Effect.orElseSucceed(() => undefined));
  };

  return SpeechPostProcessing.of({
    process: Effect.fn("SpeechPostProcessing.process")(
      function* (input) {
        if (input.transcript.trim().length === 0) return { text: input.transcript };
        const settings = yield* settingsService.getSettings;
        const providers = yield* providerRegistry.getProviders;
        const liveContext = yield* loadLiveContext(input.threadId);
        const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
        const instructions =
          (mode === "custom" ? customInstructions.trim() : "") ||
          DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
        // Providers run in a working directory; cleanup must not read a checkout.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cleanup-" });
        const generated = yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt: buildTranscriptionPostProcessingPrompt(
            instructions,
            input.transcript,
            input.draft,
            input.options.speechCorrectionWord,
            liveContext,
          ),
          modelSelection: resolveSpeechPostProcessingModelSelection(settings, providers),
        });
        const text = generated.transcription.trim();
        return {
          text:
            text.length > 0
              ? applySpeechAliases(text, input.options.speechCustomWords)
              : input.transcript,
        };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "post-processing", cause })),
    ),
  });
});

export const layer = Layer.effect(SpeechPostProcessing, make);
