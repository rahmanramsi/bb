import worker from "../src/worker.js";
import { TunnelDO, type Env } from "../src/tunnel-do.js";

function fixtureEnv(env: Env): Env {
  return {
    ...env,
    GATE_EVENTS: { writeDataPoint() {} },
  };
}

export class IdentityTunnelDO extends TunnelDO {
  constructor(state: DurableObjectState, env: Env) {
    super(state, fixtureEnv(env));
  }
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    return worker.fetch(request, fixtureEnv(env), context);
  },
};
