import { uiBridge } from "../ui-bridge.js";

export const askToolSystemPrompt = {
  snippet: "Ask the user questions with selectable options",
  guidelines: [
    "Use ask when you need a decision, preference, or missing information from the user.",
    "Do not use ask for things you can discover yourself with read, bash, or grep.",
    "Put the recommended option first and mark it with '(Recommended)'.",
  ],
};

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 12;

function normalizeQuestions(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  if (raw.length === 0) {
    throw new Error("ask requires at least one question");
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error(`ask supports at most ${MAX_QUESTIONS} questions per call`);
  }

  return raw.map((q, qi) => {
    const question = String(q?.question || "").trim();
    if (!question) throw new Error(`questions[${qi}].question is required`);

    const options = Array.isArray(q?.options) ? q.options : [];
    if (options.length > MAX_OPTIONS) {
      throw new Error(`questions[${qi}] supports at most ${MAX_OPTIONS} options`);
    }

    return {
      header: String(q?.header || "").trim().slice(0, 30) || `Question ${qi + 1}`,
      question,
      multiple: Boolean(q?.multiple),
      custom: q?.custom !== false,
      options: options.map((opt, oi) => {
        const label = String(opt?.label ?? opt ?? "").trim();
        if (!label) throw new Error(`questions[${qi}].options[${oi}].label is required`);
        return { label, description: String(opt?.description || "").trim() };
      }),
    };
  });
}

export function createAskTool() {
  return {
    name: "ask",
    description:
      "Ask the user one or more questions. Each question can offer selectable options and, unless disabled, a free-form custom answer. Use this to gather preferences, clarify ambiguity, or let the user choose an implementation direction. Returns the user's answers.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask (max 10)",
          items: {
            type: "object",
            properties: {
              header: { type: "string", description: "Very short label (max 30 chars)" },
              question: { type: "string", description: "The complete question" },
              multiple: { type: "boolean", description: "Allow selecting more than one option" },
              custom: {
                type: "boolean",
                description: "Allow a free-form answer (default true)",
              },
              options: {
                type: "array",
                description: "Selectable choices",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text (1-5 words)" },
                    description: { type: "string", description: "Explanation of the choice" },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(input, signal) {
      const questions = normalizeQuestions(input);

      if (signal?.aborted) throw new Error("Operation aborted");

      const answers = await uiBridge.ask({ questions, signal });

      if (signal?.aborted) throw new Error("Operation aborted");

      if (!Array.isArray(answers) || answers.length === 0) {
        return {
          content: [{ type: "text", text: "The user cancelled and did not answer." }],
        };
      }

      const lines = answers.map((a) => {
        const picked = Array.isArray(a.answers) ? a.answers : [];
        const value = picked.length > 0 ? picked.join(", ") : "(no answer)";
        return `"${a.question}" = "${value}"`;
      });

      return {
        content: [
          {
            type: "text",
            text: `User answered:\n${lines.join("\n")}`,
          },
        ],
        details: { answers },
      };
    },
  };
}
