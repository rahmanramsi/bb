import type {
  JsonObject,
  PromptInput,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
  ThreadOriginKind,
  ThreadVisibility,
  RoleCeiling,
} from "@bb/domain";
import type {
  CreateThreadEnvironmentArgs,
  CreateThreadRequest,
  EnvironmentArgs,
  ProviderEnvironmentArgs,
} from "@bb/server-contract";

export interface ThreadCreateServiceRequestInput {
  createdByRoleCeiling: RoleCeiling | null;
  createdByUserId: string | null;
  environment: CreateThreadEnvironmentArgs;
  executionInputSources?: CreateThreadRequest["executionInputSources"];
  /**
   * Epoch ms the first message should dispatch at. Present ⇒ the thread is
   * created `pending` with no turn and the first message is queued as a row
   * waiting on the clock.
   */
  sendAt?: CreateThreadRequest["sendAt"];
  input: PromptInput[];
  pluginMetadata?: CreateThreadRequest["pluginMetadata"];
  pluginSubmission?: CreateThreadRequest["pluginSubmission"];
  sectionId?: CreateThreadRequest["sectionId"];
  pinned?: CreateThreadRequest["pinned"];
  model?: CreateThreadRequest["model"];
  origin: ThreadCreateOrigin | null;
  originPluginId?: CreateThreadRequest["originPluginId"];
  originKind?: ThreadOriginKind | null;
  parentThreadId?: string;
  lifecycleOwnerThreadId?: string;
  permissionMode?: CreateThreadRequest["permissionMode"];
  projectId: string;
  providerId?: CreateThreadRequest["providerId"];
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
  sessionOptions?: CreateThreadRequest["sessionOptions"];
  sourceSeqEnd?: CreateThreadRequest["sourceSeqEnd"];
  sourceThreadId?: string;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  title?: string;
  visibility?: ThreadVisibility;
}

export interface ThreadCreateServiceRequest extends Omit<
  ThreadCreateServiceRequestInput,
  "environment" | "pluginMetadata" | "providerId"
> {
  authorRoleCeiling: RoleCeiling | null;
  authorUserId: string | null;
  environment: EnvironmentArgs | ProviderEnvironmentArgs;
  pluginMetadata: { pluginId: string; metadata: JsonObject } | null;
  providerId: string;
  titleFallback: string | null;
  visibility: ThreadVisibility;
}
