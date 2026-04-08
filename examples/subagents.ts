import { createAgentRuntime, type AgentResponseEvent, type ModelReference, type OpencodeAgentSession } from "../src/index.js";

const directory = process.argv[2] ?? process.cwd();
const rootAgent = process.env.OPENCODE_ROOT_AGENT ?? "build";
const model: ModelReference = (process.env.OPENCODE_MODEL ?? "openai/gpt-5.4") as `${string}/${string}`;

function formatEvent(label: string, event: AgentResponseEvent) {
    const prefix = `[${label}] [${event.source.chainText}]`;

    switch (event.type) {
        case "status":
            return `${prefix} status=${event.status}`;
        case "tool_call":
            return `${prefix} tool=${event.toolName} status=${event.status}${event.title ? ` title=${JSON.stringify(event.title)}` : ""}`;
        case "error":
            return `${prefix} error=${JSON.stringify(event.error.message)}`;
        case "result":
            return `${prefix} result=${JSON.stringify(event.result.text)}`;
        default:
            return null;
    }
}

async function drain(label: string, session: OpencodeAgentSession) {
    const discoveredSessions = new Map<string, string>();

    for await (const event of session.receiveResponse()) {
        const line = formatEvent(label, event);
        if (line) {
            console.log(line);
        }

        if (event.source.taskID && !discoveredSessions.has(event.source.taskID)) {
            discoveredSessions.set(event.source.taskID, event.source.chainText);
        }
    }

    return discoveredSessions;
}

const runtime = await createAgentRuntime({
    directory,
    model,
    config: {
        agent: {
            general: {
                permission: {
                    task: {
                        "*": "allow",
                    },
                },
            },
        },
    },
});

try {
    const root = await runtime.createSession({ agent: rootAgent, model });

    await root.query(
        [
            "Launch two general subagents in parallel.",
            "General subagent 1: read package.json and reply with only the package name.",
            "General subagent 2: launch exactly one explore subagent using the task tool.",
            "The explore subagent must read README.md and reply with only the first markdown heading.",
            "General subagent 2 must not read README.md itself.",
            "The root build agent must not read README.md itself.",
            "If the explore subagent is not launched, the task is incomplete.",
            "After both subagents finish, reply with only: root turn complete.",
        ].join("\n"),
        { includeSubagents: true },
    );

    const discoveredSessions = await drain("root", root);

    console.log("discoveredSessions=");
    for (const [sessionID, chainText] of discoveredSessions) {
        console.log(`- ${chainText} session=${sessionID}`);
    }

    const resumedTarget =
        [...discoveredSessions.entries()].find(([, chainText]) => chainText.includes("explore")) ??
        [...discoveredSessions.entries()][0];

    if (!resumedTarget) {
        console.log("resumeTarget=none discovered");
    } else {
        const [sessionID, chainText] = resumedTarget;
        console.log(`resumeTarget=${chainText} session=${sessionID}`);

        const resumed = await runtime.resumeAgent({
            sessionID,
            prompt: "Repeat your last answer in one short line.",
        });

        await drain("resume", resumed);
    }
} finally {
    await runtime.dispose();
}
