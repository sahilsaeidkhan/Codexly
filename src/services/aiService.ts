import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured.");
}

const openai = new OpenAI({
    apiKey: apiKey,
});

export async function generatePracticeQuestion(
    topic: string,
    language: string
): Promise<string> {

    try {

        const prompt = `
Generate ONE beginner-friendly coding practice question.

Topic: ${topic}
Programming Language: ${language}

Rules:
- Focus on concept building.
- Keep problem clear and structured.
- Do NOT include solution.
- Do NOT include explanation.
- Only return the question text.
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
        });

        return response.choices[0].message.content || "No question generated.";

    } catch (error: any) {
        const errorMessage = error?.message || JSON.stringify(error);
        console.error("OPENAI ERROR:", errorMessage);
        if (error?.status === 401) {
            return "OpenAI API Error: Invalid API key. Please check your OPENAI_API_KEY in .env";
        }
        return `OpenAI Error: ${errorMessage}`;
    }
}
