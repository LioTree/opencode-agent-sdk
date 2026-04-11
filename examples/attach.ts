import { createAgentRuntime, type ModelReference } from "../src/index.js";

const directory = process.argv[2] ?? process.cwd();
const serverUrl = process.env.OPENCODE_SERVER_URL;
const model: ModelReference = (process.env.OPENCODE_MODEL ?? "zhipuai-coding-plan/glm-5") as `${string}/${string}`;

if (!serverUrl) {
    throw new Error("OPENCODE_SERVER_URL is required");
}

const runtime = await createAgentRuntime({
    directory,
    serverUrl,
    model,
});

try {
    const result = await runtime.runAgent({
        agent: "general",
        prompt: "Reply with exactly ATTACH_OK and nothing else.",
    });

    const assistantInfo = result.info?.role === "assistant" ? result.info : null;

    console.log(JSON.stringify({
        agent: result.agent,
        providerID: assistantInfo?.providerID ?? null,
        modelID: assistantInfo?.modelID ?? null,
        sessionID: result.sessionID,
        text: result.text,
    }, null, 2));
} finally {
    await runtime.dispose();
}
