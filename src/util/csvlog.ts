import fs from "fs";
import path from "path";

type Row = Record<string, string | number | null | undefined>;

export class CsvLog {
  private file: string;
  private wroteHeader = false;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  private esc(x: any) {
    if (x === null || x === undefined) return "";
    const s = String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  write(row: Row) {
    const keys = Object.keys(row);
    if (!this.wroteHeader) {
      fs.appendFileSync(this.file, keys.join(",") + "\n");
      this.wroteHeader = true;
    }
    const line = keys.map((k) => this.esc(row[k])).join(",") + "\n";
    fs.appendFileSync(this.file, line);
  }
}
