import {
  createDesktopBrowsersArea,
  type ExperimentalDesktopBrowsersArea,
} from "./areas/desktop-browsers.js";
import { createHttpTransport } from "./transport-http.js";
import { createAuthArea, type ExperimentalAuthArea } from "./areas/auth.js";
import type { BbSdkContext, BbSdkTransport } from "./transport.js";
import {
  createEnvironmentsArea,
  type EnvironmentsArea,
} from "./areas/environments.js";
import { createFilesArea, type FilesArea } from "./areas/files.js";
import type { GuideArea } from "./areas/guide.js";
import { createHostsArea, type HostsArea } from "./areas/hosts.js";
import {
  createServerArea,
  type ExperimentalServerArea,
} from "./areas/server.js";
import { createProjectsArea, type ProjectsArea } from "./areas/projects.js";
import { createProvidersArea, type ProvidersArea } from "./areas/providers.js";
import { createPluginsArea, type PluginsArea } from "./areas/plugins.js";
import {
  createPromptHistoryArea,
  type ExperimentalPromptHistoryArea,
} from "./areas/prompt-history.js";
import { createUsersArea, type ExperimentalUsersArea } from "./areas/users.js";
import { createBbRealtimeClient } from "./realtime-client.js";
import type { BbRealtime } from "./realtime-types.js";
import { createStatusArea, type StatusArea } from "./areas/status.js";
import { createSkillsArea, type SkillsArea } from "./areas/skills.js";
import { createThemeArea, type ThemeArea } from "./areas/theme.js";
import { createSystemArea, type SystemArea } from "./areas/system.js";
import { createTerminalsArea, type TerminalsArea } from "./areas/terminals.js";
import { createThreadsArea, type ThreadsArea } from "./areas/threads.js";
import {
  createThreadSectionsArea,
  type ThreadSectionsArea,
} from "./areas/thread-sections.js";

export type * from "./public-types.js";
export { createBuiltinPlanCommandTextInput } from "@bb/domain";

export interface CreateBbSdkArgs {
  context?: BbSdkContext;
  transport: BbSdkTransport;
}

export interface CreateBbSdkWithGuideArgs extends CreateBbSdkArgs {
  guide: GuideArea;
}

export interface BbSdkAreas extends BbRealtime {
  experimental_auth: ExperimentalAuthArea;
  experimental_desktopBrowsers: ExperimentalDesktopBrowsersArea;
  experimental_promptHistory: ExperimentalPromptHistoryArea;
  experimental_server: ExperimentalServerArea;
  experimental_users: ExperimentalUsersArea;
  environments: EnvironmentsArea;
  files: FilesArea;
  hosts: HostsArea;
  projects: ProjectsArea;
  plugins: PluginsArea;
  providers: ProvidersArea;
  skills: SkillsArea;
  status: StatusArea;
  system: SystemArea;
  terminals: TerminalsArea;
  theme: ThemeArea;
  threadSections: ThreadSectionsArea;
  threads: ThreadsArea;
}

export interface BbSdk extends BbSdkAreas {
  guide: GuideArea;
}

export function createBbSdk(args: CreateBbSdkWithGuideArgs): BbSdk;
export function createBbSdk(args: CreateBbSdkArgs): BbSdkAreas;
export function createBbSdk(
  args: CreateBbSdkArgs | CreateBbSdkWithGuideArgs,
): BbSdkAreas | BbSdk {
  let transport = args.transport;
  if (args.context?.authToken !== undefined) {
    const authenticated = createHttpTransport({
      ...transport,
      context: args.context,
    });
    transport = {
      ...transport,
      api: authenticated.api,
      fetch: authenticated.fetch,
    };
  }
  const sdkContext = { transport };
  const realtime = createBbRealtimeClient({
    transport,
  });
  const areas: BbSdkAreas = {
    experimental_auth: createAuthArea(sdkContext),
    experimental_desktopBrowsers: createDesktopBrowsersArea(sdkContext),
    experimental_promptHistory: createPromptHistoryArea(sdkContext),
    experimental_server: createServerArea(sdkContext),
    experimental_users: createUsersArea(sdkContext),
    environments: createEnvironmentsArea(sdkContext),
    files: createFilesArea(sdkContext),
    hosts: createHostsArea(sdkContext),
    subscribe(args) {
      return realtime.subscribe(args);
    },
    projects: createProjectsArea(sdkContext),
    plugins: createPluginsArea(sdkContext),
    providers: createProvidersArea(sdkContext),
    skills: createSkillsArea(sdkContext),
    status: createStatusArea(sdkContext),
    system: createSystemArea(sdkContext),
    terminals: createTerminalsArea(sdkContext),
    theme: createThemeArea(sdkContext),
    threadSections: createThreadSectionsArea(sdkContext),
    threads: createThreadsArea(sdkContext),
  };
  return "guide" in args ? { ...areas, guide: args.guide } : areas;
}
