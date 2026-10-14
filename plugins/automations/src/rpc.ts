import {
  automationDetailReadResultSchema,
  automationDetailResponseSchema,
  automationListResponseSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  automationRunsInputSchema,
  automationsOverviewResponseSchema,
  createAutomationInputSchema,
  listAutomationsInputSchema,
  projectAutomationInputSchema,
  runAutomationInputSchema,
  updateAutomationInputSchema,
} from "./rpc-types.js";
import { z } from "zod";
import {
  defineRpcContract,
  experimental_PluginRpcForbiddenError,
} from "@get-bb/plugin-sdk";
import type { AutomationService } from "./service.js";

export const automationRpcContract = defineRpcContract({
  automations_overview: {
    input: z.null(),
    output: automationsOverviewResponseSchema,
  },
  automations_list: {
    input: listAutomationsInputSchema,
    output: automationListResponseSchema,
  },
  automations_get: {
    input: projectAutomationInputSchema,
    output: automationDetailReadResultSchema,
  },
  automations_create: {
    input: createAutomationInputSchema,
    output: automationDetailResponseSchema,
  },
  automations_create_script: {
    input: createAutomationInputSchema,
    output: automationDetailResponseSchema,
    experimental_requiredRole: "admin",
  },
  automations_update: {
    input: updateAutomationInputSchema,
    output: automationDetailResponseSchema,
  },
  automations_update_script: {
    input: updateAutomationInputSchema,
    output: automationDetailResponseSchema,
    experimental_requiredRole: "admin",
  },
  automations_delete: {
    input: projectAutomationInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_pause: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_pause_script: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
    experimental_requiredRole: "admin",
  },
  automations_resume: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_resume_script: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
    experimental_requiredRole: "admin",
  },
  automations_run: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
  },
  automations_run_script: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
    experimental_requiredRole: "admin",
  },
  automations_runs: {
    input: automationRunsInputSchema,
    output: automationRunListResponseSchema,
  },
});

function scriptAdminRequired(method: string): Error {
  return new experimental_PluginRpcForbiddenError(
    `Script automations require an admin; admins use ${method}_script.`,
  );
}

export function createRpcHandlers(service: AutomationService) {
  const isScriptAutomation = (input: {
    projectId: string;
    automationId: string;
  }): boolean => service.runMode(input) === "script";
  return {
    automations_overview() {
      return service.overview();
    },
    automations_list(input: z.output<typeof listAutomationsInputSchema>) {
      return service.list(input);
    },
    automations_get(input: z.output<typeof projectAutomationInputSchema>) {
      return service.get(input);
    },
    automations_create(input: z.output<typeof createAutomationInputSchema>) {
      if (input.execution.mode === "script") {
        throw scriptAdminRequired("automations_create");
      }
      return service.create(input);
    },
    automations_create_script(
      input: z.output<typeof createAutomationInputSchema>,
    ) {
      return service.create(input);
    },
    automations_update(input: z.output<typeof updateAutomationInputSchema>) {
      if (
        input.execution?.mode === "script" ||
        input.script !== undefined ||
        isScriptAutomation(input)
      ) {
        throw scriptAdminRequired("automations_update");
      }
      return service.update(input);
    },
    automations_update_script(
      input: z.output<typeof updateAutomationInputSchema>,
    ) {
      return service.update(input);
    },
    automations_delete(input: z.output<typeof projectAutomationInputSchema>) {
      return service.delete(input);
    },
    automations_pause(input: z.output<typeof projectAutomationInputSchema>) {
      if (isScriptAutomation(input)) {
        throw scriptAdminRequired("automations_pause");
      }
      return service.pause(input);
    },
    automations_pause_script(
      input: z.output<typeof projectAutomationInputSchema>,
    ) {
      return service.pause(input);
    },
    automations_resume(input: z.output<typeof projectAutomationInputSchema>) {
      if (isScriptAutomation(input)) {
        throw scriptAdminRequired("automations_resume");
      }
      return service.resume(input);
    },
    automations_resume_script(
      input: z.output<typeof projectAutomationInputSchema>,
    ) {
      return service.resume(input);
    },
    automations_run(input: z.output<typeof runAutomationInputSchema>) {
      if (isScriptAutomation(input)) {
        throw scriptAdminRequired("automations_run");
      }
      return service.run(input);
    },
    automations_run_script(input: z.output<typeof runAutomationInputSchema>) {
      return service.run(input);
    },
    automations_runs(input: z.output<typeof automationRunsInputSchema>) {
      return service.runs(input);
    },
  };
}
