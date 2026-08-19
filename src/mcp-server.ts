// mcp-server.ts — MCP server exposing Minerva's core ABI (agent-interactivity epic).
//
// A thin adapter over dispatch.ts, Minerva's single existing entrypoint (see docs/architecture.md
// AD-1) -- every tool call here is exactly `dispatch({method, params})`, no new business logic,
// no duplicated validation. dispatch.ts's MinervaError -> {code, message} mapping is reused
// as-is; a tool call's result is {content:[{type:"text", text: JSON.stringify(...)}], isError?}
// per the MCP CallToolResult contract, so a calling agent gets the identical JSON shape it would
// get from the stdin-JSON ABI, just delivered as an MCP tool result instead of raw stdout.
//
// Descriptions below are written for the calling AGENT, not a human reader -- they carry the
// AD-5 "No Autonomous Progress" contract (never fabricate an answer; a run only advances on a
// real submitAnswers call) and the agent/human channel split, since an agent driving Minerva
// needs that context to use these tools correctly, not just their JSON shapes.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { dispatch } from "./dispatch.ts";
import { isUuidShaped } from "./run-manager.ts";

const SERVER_NAME = "minerva";
const SERVER_VERSION = "0.1.0";

// validate-run-id-uuid-shape story: mirrors dispatch.ts's RUN_ID_METHODS. mcp-server.ts is the
// other of the two ABI boundaries in front of run-manager.ts's runDir()/runRecordPath()
// path-join, so it rejects a non-UUID run_id here, before ever forwarding to dispatch().
const RUN_ID_TOOLS = new Set(["getRunStatus", "getQuestions", "submitAnswers", "getOutput", "abortRun"]);

const TOOLS: Tool[] = [
  {
    name: "capabilities",
    description: "Report Minerva's ABI version. Call this first if you're unsure Minerva is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "startRun",
    description:
      "Start a new headless idea-to-spec run. Returns {run_id}. The run then drives itself " +
      "(kickoff+plan) and PARKS the moment it needs a decision -- it never guesses or fabricates " +
      "an answer (AD-5, No Autonomous Progress). After calling this, poll getQuestions for the " +
      "run_id until you see a pending question, or the run reaches status 'complete'.",
    inputSchema: {
      type: "object",
      properties: {
        idea: { type: "string", description: "The idea/requirement to plan, as free text. Required." },
        target_repo: { type: "string", description: "Optional owner/repo (or local path) to plan against. Omit for a fresh scratch workspace." },
        defaults: { type: "object", description: "Optional pre-baked-defaults override (see docs/plan-defaults.example.yaml). Omit to use the operator-configured default." },
      },
      required: ["idea"],
    },
  },
  {
    name: "getRunStatus",
    description:
      "Get a run's current status: 'in_progress' | 'waiting_on_human' | 'complete' | 'aborted'. " +
      "Polling this never advances the run on its own -- only submitAnswers does.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "listRuns",
    description: "List every run this Minerva instance knows about, with id/status/created_at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "getQuestions",
    description:
      "Get a run's PENDING questions on one channel. channel='agent' is for questions you (the " +
      "calling agent) can and should answer yourself, using your own judgment or context -- " +
      "routine, low-stakes gates. channel='human' is for genuine strategic decisions that need a " +
      "real human -- do NOT answer these yourself or guess on the human's behalf; surface them to " +
      "your own operator/user and wait for a real answer before calling submitAnswers on that " +
      "channel.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        channel: { type: "string", enum: ["agent", "human"] },
      },
      required: ["run_id", "channel"],
    },
  },
  {
    name: "submitAnswers",
    description:
      "Answer a run's pending question on a channel, advancing the run. This is the ONLY thing " +
      "that ever advances a parked run -- never call this with a fabricated or guessed answer on " +
      "the 'human' channel; only submit an answer a real human actually gave.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        channel: { type: "string", enum: ["agent", "human"] },
        answers: {
          type: "array",
          description: "Exactly the pending question(s) being answered, as {question_id, answer}.",
          items: {
            type: "object",
            properties: {
              question_id: { type: "string" },
              answer: {
                description: "A string for single-select/free-text; an array of strings for multi-select.",
                oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
            },
            required: ["question_id", "answer"],
          },
        },
      },
      required: ["run_id", "channel", "answers"],
    },
  },
  {
    name: "getOutput",
    description:
      "Fetch a completed run's approved epic + stories. Fails with NOT_READY if the run hasn't " +
      "reached status 'complete' yet -- never returns a partial artifact.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "abortRun",
    description: "Abort a run. Idempotent -- safe to call on an already-terminal run.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
];

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;
    if (RUN_ID_TOOLS.has(name) && !isUuidShaped(params.run_id)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code: "VALIDATION_FAILED", message: "run_id must be a valid UUID", retry_after_ms: null }),
          },
        ],
        isError: true,
      };
    }
    const response = await dispatch({ method: name, params });
    if ("error" in response) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.error) }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(response.result) }] };
  });

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
