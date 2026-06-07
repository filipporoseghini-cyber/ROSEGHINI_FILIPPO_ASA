// LOAD the configuration from .env file and configure the LLM endpoint
import "dotenv/config";
import OpenAI from "openai";

const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

// Create an OpenAI-compatible client
const client = new OpenAI({
    baseURL,
    apiKey,
});

// Messages array with:
// - system message: the LLM must answer with a maximum of 20 words
// - user message: the actual question
const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
        {
            role: "system",
            content: "You are a concise assistant. Answer with a maximum of 20 words.",
        },
        {
            role: "user",
            content: "How much is 377834873478 * 974829994?",
        },
    ],
    // The level of determinism (creativity): 0.0 -> determinism (no creativity)
    temperature: 0.1,
});

console.log(response.choices[0].message.content);
