import { stripVTControlCharacters, styleText } from "node:util";

export const moduleFormats = ["cjs", "esm"] as const;
export type ConsumerFormat = (typeof moduleFormats)[number];
export type ConsumerCheck = ConsumerFormat | "compatibility";

export function consumerFormats(selection: string): readonly ConsumerFormat[] {
  if (selection === "both") return moduleFormats;
  if (selection === "cjs" || selection === "esm") return [selection];
  throw new Error("--format must be both, cjs or esm");
}

export function formatName(format: ConsumerFormat): string {
  return styleText(
    format === "cjs" ? "magenta" : "yellow",
    format.toUpperCase(),
  );
}

function stageCategory(label: string): string {
  if (label === "CJS") return formatName("cjs");
  if (label === "ESM") return formatName("esm");
  return styleText(label === "CLEANUP" ? "yellow" : "cyan", label);
}

function resultToken(result: boolean | undefined): string {
  if (result === undefined) return styleText(["bold", "yellow"], "NOT RUN");
  return styleText(
    ["bold", result ? "green" : "red"],
    result ? "PASS" : "FAIL",
  );
}

export function createRegistryReporter(
  formats: readonly ConsumerFormat[],
  verbose = false,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
) {
  const results = new Map<string, boolean>();
  // Eight shared stages, plus setup, install, file verification, two import
  // processes and a compatibility process for each consumer project.
  const stageTotal = 8 + formats.length * 6;
  let stageNumber = 0;
  let sectionNumber = 0;
  let activeStage = "initialisation";
  let failedStage: string | undefined;

  function section(title: string, detail?: string): void {
    const number = styleText("blue", String(++sectionNumber).padStart(2, "0"));
    const suffix = detail ? `  ${detail}` : "";
    write(`\n  ${number}  ${title}${suffix}\n`);
    write(`  ${"-".repeat(73)}\n`);
  }

  async function stage<T>(
    label: string,
    description: string,
    action: () => T | Promise<T>,
  ): Promise<T> {
    activeStage = `${label}: ${stripVTControlCharacters(description)}`;
    const number = `[${String(++stageNumber).padStart(2, "0")}/${stageTotal}]`;
    const category = stageCategory(label);
    const prefix = `    ${styleText("dim", number)}  ${category}${" ".repeat(Math.max(2, 11 - label.length))}${description}`;
    const line = `${prefix}${" ".repeat(Math.max(2, 87 - stripVTControlCharacters(prefix).length))}`;
    write(verbose ? `${prefix}\n` : line);
    const started = Date.now();
    function status(success: boolean): void {
      const token = resultToken(success);
      write(
        `${verbose ? "            " : ""}${token}  ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
      );
    }
    try {
      const result = await action();
      status(true);
      return result;
    } catch (error) {
      failedStage ??= activeStage;
      status(false);
      throw error;
    }
  }

  async function check(
    project: ConsumerFormat,
    target: ConsumerCheck,
    action: () => unknown,
  ): Promise<void> {
    try {
      await action();
      results.set(`${project}:${target}`, true);
    } catch (error) {
      results.set(`${project}:${target}`, false);
      throw error;
    }
  }

  function resultRow(name: string, result: boolean | undefined): void {
    const gap = " ".repeat(
      Math.max(2, 60 - stripVTControlCharacters(name).length),
    );
    write(`    ${name}${gap}${resultToken(result)}\n`);
  }

  return {
    header(name: string, version: string): void {
      const label = styleText("magenta", `${name}@${version}`);
      write(`\n  ${styleText(["bold", "cyan"], "VERDACCIO")}  ${label}\n`);
      write(
        `  Publish and install smoke tests  Node ${process.version}  |  ${formats.map((format) => format.toUpperCase()).join(" + ")}${verbose ? "  |  verbose" : ""}\n`,
      );
    },
    section,
    stage,
    check,
    summary(success: boolean): void {
      section(styleText(["bold", "cyan"], "RESULTS"));
      let importsPassed = 0;
      let compatibilityPassed = 0;
      for (const project of formats) {
        for (const target of moduleFormats) {
          const result = results.get(`${project}:${target}`);
          if (result === true) importsPassed++;
          resultRow(
            `${formatName(project)} project importing ${formatName(target)} module`,
            result,
          );
        }
      }
      write(`\n    ${styleText(["bold", "blue"], "ADDITIONAL CHECKS")}\n`);
      for (const project of formats) {
        const result = results.get(`${project}:compatibility`);
        if (result === true) compatibilityPassed++;
        resultRow(
          `${formatName(project)} extension lookup, basePath and missing files`,
          result,
        );
      }
      const importCount = styleText(
        "cyan",
        `${importsPassed}/${formats.length * moduleFormats.length}`,
      );
      const compatibilityCount = styleText(
        "cyan",
        `${compatibilityPassed}/${formats.length}`,
      );
      write(
        `\n  ${resultToken(success)}  ${importCount} import pairs  |  ${compatibilityCount} compatibility checks\n`,
      );
      let message = "Published package verified in isolated projects";
      if (!success) message = `Stopped at ${failedStage ?? activeStage}`;
      write(`  ${message}.\n\n`);
    },
  };
}
