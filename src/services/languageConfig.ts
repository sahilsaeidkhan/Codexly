import * as path from "path";
import * as os from "os";

export interface LanguageConfig {
    compile?: {
        command: string;
        args: string[];
    };
    run: {
        command: string;
        args: string[];
    };
}

/**
 * Returns language execution configuration
 * based on VS Code languageId and file path.
 */
export function getLanguageConfig(
    languageId: string,
    filePath: string
): LanguageConfig | null {

    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const fileNameWithoutExt = fileName.split(".")[0];

    const isWindows = os.platform() === "win32";

    switch (languageId) {

        // =========================
        // Python
        // =========================
        case "python":
            return {
                run: {
                    command: "python3",
                    args: [filePath]
                }
            };

        // =========================
        // JavaScript
        // =========================
        case "javascript":
            return {
                run: {
                    command: "node",
                    args: [filePath]
                }
            };

        // =========================
        // TypeScript
        // =========================
        case "typescript":
            return {
                run: {
                    command: "npx",
                    args: ["ts-node", filePath]
                }
            };

        // =========================
        // Java
        // =========================
        case "java":
            return {
                compile: {
                    command: "javac",
                    args: [filePath]
                },
                run: {
                    command: "java",
                    args: ["-cp", fileDir, fileNameWithoutExt]
                }
            };

        // =========================
        // C
        // =========================
        case "c":
            const cOutput = isWindows
                ? `${fileNameWithoutExt}.exe`
                : `./${fileNameWithoutExt}`;

            return {
                compile: {
                    command: "gcc",
                    args: [filePath, "-o", fileNameWithoutExt]
                },
                run: {
                    command: cOutput,
                    args: []
                }
            };

        // =========================
        // C++
        // =========================
        case "cpp":
        case "c++":
            const cppOutput = isWindows
                ? `${fileNameWithoutExt}.exe`
                : `./${fileNameWithoutExt}`;

            return {
                compile: {
                    command: "g++",
                    args: [filePath, "-o", fileNameWithoutExt]
                },
                run: {
                    command: cppOutput,
                    args: []
                }
            };

        // =========================
        // Go
        // =========================
        case "go":
            return {
                run: {
                    command: "go",
                    args: ["run", filePath]
                }
            };

        // =========================
        // Ruby
        // =========================
        case "ruby":
            return {
                run: {
                    command: "ruby",
                    args: [filePath]
                }
            };

        // =========================
        // Default (Unsupported)
        // =========================
        default:
            return null;
    }
}
