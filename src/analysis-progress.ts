import { writeSync } from "node:fs";
import type { AnalysisProgress } from "./analysis-types.js";

interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

/** Throttled stderr display; synchronous writes remain live during synchronous analysis. */
export class AnalysisProgressDisplay {
  private lastStage?: AnalysisProgress["stage"];
  private lastTime = -Infinity;
  private active = false;

  constructor(
    private readonly stream: ProgressStream = process.stderr,
    private readonly enabled = Boolean(stream.isTTY),
    private readonly now: () => number = Date.now,
  ) {}

  update(progress: AnalysisProgress): void {
    if (!this.enabled) return;
    const time = this.now();
    const stageChanged = this.lastStage !== progress.stage;
    const fileFinished = progress.stage === "files" && progress.completed === progress.total;
    if (!stageChanged && !fileFinished && time - this.lastTime < 100) return;
    this.lastStage = progress.stage;
    this.lastTime = time;
    let text: string;
    switch (progress.stage) {
      case "load": text = "Loading analysis database..."; break;
      case "scan": text = `Scanning Lua directory... ${progress.total} file(s) found`; break;
      case "files": {
        const ratio = progress.total ? progress.completed / progress.total : 1;
        const filled = Math.floor(ratio * 20);
        text = `Files [${"=".repeat(filled)}${"-".repeat(20 - filled)}] ${Math.floor(ratio * 100)}% ${progress.completed}/${progress.total} | parsed ${progress.parsed}, reused ${progress.reused}`;
        if (progress.file) text += ` | ${progress.file}`;
        break;
      }
      case "resolve": text = "Resolving module dependencies..."; break;
      case "index": text = "Building global and dependency indexes..."; break;
      case "write": text = "Writing analysis database..."; break;
      case "done": text = `Analysis complete: ${progress.completed}/${progress.total} files | parsed ${progress.parsed}, reused ${progress.reused}`; break;
    }
    // Paths may contain control characters. Avoid terminal escapes or extra lines from filenames.
    text = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
    if (this.stream.isTTY) {
      // Reserve one column to prevent terminal wrapping; count non-ASCII characters conservatively.
      const maxWidth = Math.max(1, (this.stream.columns ?? 100) - 1);
      let width = 0;
      let clipped = "";
      for (const character of text) {
        const nextWidth = /[\x20-\x7e]/.test(character) ? 1 : 2;
        if (width + nextWidth > maxWidth) break;
        clipped += character;
        width += nextWidth;
      }
      this.write(`\r\x1b[2K${clipped}${progress.stage === "done" ? "\n" : ""}`);
      this.active = progress.stage !== "done";
    } else {
      this.write(`${text}\n`);
    }
  }

  stop(): void {
    if (this.active) this.write("\n");
    this.active = false;
  }

  private write(text: string): void {
    if (this.stream === process.stderr) writeSync(process.stderr.fd, text);
    else this.stream.write(text);
  }
}
