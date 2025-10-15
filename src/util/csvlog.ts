import fs from "fs";
import path from "path";

type Row = Record<string, string | number | null | undefined>;

type CsvLogOpts = {
  truncate?: boolean;
  header?: string[];
};

export class CsvLog {
  private file: string;
  private wroteHeader = false;
  private header?: string[];

  constructor(file: string, opts: CsvLogOpts = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });

    if (opts.truncate) fs.writeFileSync(this.file, "");

    if (opts.header && opts.header.length) {
      this.header = [...opts.header];
      fs.appendFileSync(this.file, this.header.join(",") + "\n");
      this.wroteHeader = true;
    }
  }

  private esc(x: any) {
    if (x === null || x === undefined) return "";
    const s = String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  write(row: Row) {
    const keys = this.header ?? Object.keys(row);

    if (!this.wroteHeader) {
      fs.appendFileSync(this.file, keys.join(",") + "\n");
      this.wroteHeader = true;
      if (!this.header) this.header = keys;
    }

    const line = this.header!.map((k) => this.esc(row[k])).join(",") + "\n";
    fs.appendFileSync(this.file, line);
  }
}
