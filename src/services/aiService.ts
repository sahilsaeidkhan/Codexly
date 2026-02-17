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
    language: string,
    difficulty: string
): Promise<string> {

    try {

        // 🔥 Language-specific enforcement
        let languageInstruction = "";

        if (language === "javascript") {
            languageInstruction = `
- Generate PURE JavaScript.
- DO NOT use TypeScript type annotations.
- DO NOT use ": number", ": string", "number[]", etc.
- Do NOT write function signatures with types.
`;
        } else if (language === "typescript") {
            languageInstruction = `
- Generate proper TypeScript.
- Type annotations are allowed.
`;
        } else if (language === "python") {
            languageInstruction = `
- Generate proper Python.
- Do NOT use JavaScript syntax.
`;
        }

        const prompt = `
Generate a ${difficulty} level coding practice problem.

Topic: ${topic}
Programming Language: ${language}

${languageInstruction}

Return output STRICTLY in this format:

[QUESTION]
Clear problem statement only.

[HINT]
A helpful hint for solving the problem.

[SOLUTION]
Complete correct solution in ${language}.

Rules:
- DO NOT wrap the solution in markdown.
- DO NOT use triple backticks.
- Return raw code only inside [SOLUTION].
- Do not add extra headings.
- Do not add explanations outside blocks.
- Do not remove the block labels.
- Solution must be valid runnable ${language} code.
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "user", content: prompt }
            ],
            temperature: 0.6,
        });

        let rawText = response.choices[0].message.content || "No content generated.";

        // 🔥 Safe Cleanup Layer
            rawText = rawText
        .replace(/```[\w]*\n?/g, "")   // remove ```python or ```
        .replace(/```/g, "")          // remove closing ```
        .replace(/^\s*[=-]{3,}\s*$/gm, "")
        .replace(/Question:/gi, "")
        .trim();


        return rawText;

    } catch (error: any) {

        const errorMessage = error?.message || JSON.stringify(error);
        console.error("OPENAI ERROR:", errorMessage);

        if (error?.status === 401) {
            return "OpenAI API Error: Invalid API key. Please check your OPENAI_API_KEY in .env";
        }

        if (error?.status === 429) {
            return "OpenAI API Error: Quota exceeded. Check billing settings.";
        }

        return `OpenAI Error: ${errorMessage}`;
    }
}
