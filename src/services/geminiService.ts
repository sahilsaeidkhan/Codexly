import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured. Add it to your .env file.");
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * Generate a practice question with hint and solution.
 */
export async function generatePracticeQuestion(
    topic: string,
    language: string,
    difficulty: string
): Promise<string> {
    try {
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

Rules for [SOLUTION]:
- DO NOT wrap the solution in markdown.
- DO NOT use triple backticks.
- Return raw code only inside [SOLUTION].
- Do not add extra headings.
- Do not add explanations outside blocks.
- Do not remove the block labels.
- Solution must be valid runnable ${language} code.
- Solution MUST include both function definition AND an execution block.
- After defining the function, ALWAYS include a small execution block that:
  * Calls the function with sample input.
  * Prints or logs the result.
${language === 'python' ? `- For Python: Add execution block as:
  if __name__ == "__main__":
      print(function_name(sample_input))` : `- For ${language}: Add execution block as:
  console.log(function_name(sample_input));`}
- The code must be immediately runnable when user clicks Run.
- Do not include any markdown or explanations.
`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.6 },
        });

        let rawText = result.response.text() || "No content generated.";

        // Safe cleanup — strip markdown artifacts
        rawText = rawText
            .replace(/```[\w]*\n?/g, "")
            .replace(/```/g, "")
            .replace(/^\s*[=-]{3,}\s*$/gm, "")
            .replace(/Question:/gi, "")
            .trim();

        return rawText;

    } catch (error: any) {
        const errorMessage = error?.message || JSON.stringify(error);
        console.error("GEMINI ERROR:", errorMessage);

        if (errorMessage.includes("API_KEY_INVALID") || errorMessage.includes("401")) {
            return "Gemini API Error: Invalid API key. Please check your GEMINI_API_KEY in .env";
        }

        if (errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
            return "Gemini API Error: Quota exceeded. Check your Google AI Studio billing.";
        }

        return `Gemini Error: ${errorMessage}`;
    }
}

/**
 * Evaluate user code against a reference solution.
 */
export async function evaluateCode(
    languageId: string,
    storedSolution: string,
    userCode: string
): Promise<string> {
    const prompt = `You are a code reviewer. Analyze this ${languageId} code and provide a SHORT evaluation.

REFERENCE SOLUTION:
${storedSolution}

USER'S CODE:
${userCode}

Respond EXACTLY in this format (no markdown, no decorators):

Code Evaluation Summary:

Correctness:
<2 sentences max about correctness. Use "Your code">

Edge Cases:
<2 sentences max, or "Handles edge cases well">

Time Complexity:
<2 sentences max, or "Complexity is appropriate">

Code Quality:
<2 sentences max, or "Code is clean and readable">

Final Verdict:
<Correct / Partially Correct / Needs Improvement>

IF YOUR CODE NEEDS IMPROVEMENTS, append this section ONLY IF NEEDED:

Suggestions:

LINE <number>:
Issue: <brief issue description>
Better Approach: <what to do instead>
Example Replacement: <1-2 lines of code>

Only suggest lines with clear improvements. Keep to 2-3 suggestions maximum.

IMPORTANT:
- Do NOT add markdown formatting.
- Do NOT wrap anything in backticks.
- Do NOT add decorative lines or borders.
- Speak directly: "Your code" not "the user's code".
- If no improvements needed, do NOT include Suggestions section.`;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 },
    });

    return result.response.text() || "Evaluation could not be generated.";
}

/**
 * Explain code by adding inline comments before each line.
 */
export async function explainCode(
    languageId: string,
    code: string
): Promise<string> {
    const prompt = `
Explain the following ${languageId} code.

Rules:
- Add ONE short comment line before each line of code.
- Do NOT remove original code.
- Do NOT add markdown formatting.
- Do NOT wrap in triple backticks.
- Return ONLY code with explanation comments.

Code:
${code}
`;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
    });

    return result.response.text() || "";
}

/**
 * Explain a selected code block line by line for beginners.
 */
export async function explainSelection(
    languageId: string,
    selectedText: string
): Promise<string> {
    const prompt = `You are a coding tutor explaining code to a beginner.

Explain the following ${languageId} code selection line by line.

Rules:
- Before EACH line of code, add ONE short comment explaining what that line does.
- Use very simple, clear language. Avoid jargon.
- Be creative and use different analogies or examples each time.
- If helpful, add a tiny inline example in the comment.
- Do NOT remove any original code lines.
- Do NOT add markdown formatting.
- Do NOT wrap in triple backticks.
- Do NOT add decorative borders or separators.
- Return ONLY the commented + original code. Nothing else.

Code to explain:
${selectedText}`;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 },
    });

    return result.response.text()?.trim() || selectedText;
}
