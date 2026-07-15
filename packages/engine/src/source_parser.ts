import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Config } from './config.js';

const execFileAsync = promisify(execFile);

/** 30-second timeout for external processes (CFR, javap). */
const PROCESS_TIMEOUT_MS = 30_000;
/** 16 MB maxBuffer for external process stdout/stderr. */
const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;

export interface ClassDetail {
  className: string;
  source?: string;
  signatures?: string[];
  doc?: string;
  language?: string;
}

export class SourceParser {

  public static async getClassDetail(
    jarPath: string,
    className: string,
    type: 'signatures' | 'docs' | 'source'
  ): Promise<ClassDetail | null> {
    if (type === 'signatures') {
      return this.getSignaturesWithJavap(jarPath, className);
    }

    // className: com.example.MyClass
    // internalPath: com/example/MyClass.java
    const basePath = className.replace(/\./g, '/');
    const candidates = [
        basePath + '.java',
        basePath + '.kt'
    ];

    const result = await new Promise<ClassDetail | null>((resolve, reject) => {
        yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
            if (err || !zipfile) {
                resolve(null);
                return;
            }

            let found = false;

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                if (candidates.includes(entry.fileName)) {
                    found = true;
                    const language = entry.fileName.endsWith('.kt') ? 'kotlin' : 'java';
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err || !readStream) {
                            resolve(null);
                            return;
                        }

                        const chunks: Buffer[] = [];
                        readStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                        readStream.on('end', () => {
                            const source = Buffer.concat(chunks).toString('utf-8');
                            resolve(SourceParser.parse(className, source, type, language));
                        });
                    });
                } else {
                    zipfile.readEntry();
                }
            });

            zipfile.on('end', () => {
                if (!found) resolve(null);
            });
        });
    });

    if (result) {
        return result;
    }

    // Fallback to decompilation if source not found in this JAR
    // Note: This works best if the provided jarPath is the MAIN jar.
    // If it is the sources jar, decompilation will fail (as it doesn't contain .class files),
    // returning null.
    if (type === 'source' || type === 'docs') {
        return this.decompileClass(jarPath, className, type);
    }

    return null;
  }

  private static async decompileClass(jarPath: string, className: string, type: 'source' | 'docs'): Promise<ClassDetail | null> {
      const config = await Config.getInstance();
      const cfrPath = config.getCfrJarPath();

      if (!cfrPath || !fs.existsSync(cfrPath)) {
          throw new Error(`CFR jar not found at ${cfrPath}`);
      }

      // java -cp cfr.jar<delim>jarPath org.benf.cfr.reader.Main className
      const classpath = `${cfrPath}${path.delimiter}${jarPath}`;

      try {
          const { stdout, stderr } = await execFileAsync(
              'java',
              ['-cp', classpath, 'org.benf.cfr.reader.Main', className],
              { timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER }
          );

          // T4.15: when both stdout and stderr are empty, treat as a non-result.
          if (!stdout && !stderr) {
              return null;
          }

          if (!stdout && stderr) {
             console.error(`CFR stderr for ${className}:`, stderr);
             throw new Error(`CFR stderr: ${stderr}`);
          }

          if (stdout) {
              return this.parse(className, stdout, type, 'java');
          }

          return null;
      } catch (e: any) {
          console.error(`CFR failed for ${className} in ${jarPath}:`, e.message);
          throw e; // Rethrow to let caller handle
      }
  }

  private static async getSignaturesWithJavap(jarPath: string, className: string): Promise<ClassDetail | null> {
    try {
      const config = await Config.getInstance();
      const javap = config.getJavapPath();

      // Use -public to show public members (closest to API surface)
      const { stdout } = await execFileAsync(
          javap,
          ['-cp', jarPath, className],
          { timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER }
      );

      // T4.14: keep only lines that look like method/constructor signatures (contain "(" and ")").
      // Filters out class header, "Compiled from", "}", "static {};", etc.
      const lines = stdout.split('\n')
        .map(l => l.trim())
        .filter(l =>
          l.length > 0 &&
          l.includes('(') &&
          l.includes(')') &&
          !l.startsWith('Compiled from') &&
          !l.includes('static {};') &&
          l !== '}'
        );

      return {
        className,
        signatures: lines,
        language: 'java'
      };
    } catch (e) {
      // If javap fails (e.g. class not found in main jar), return null
      return null;
    }
  }

  private static parse(className: string, source: string, type: 'signatures' | 'docs' | 'source', language: string = 'java'): ClassDetail {
      if (type === 'source') {
          return { className, source, language };
      }

      // Very simple regex-based parsing to extract methods and javadocs
      // This is heuristic and won't be perfect, but it's fast and dependency-free
      const signatures: string[] = [];
      let doc = "";
      const allDocs: string[] = [];

      const lines = source.split('\n');
      let currentDoc: string[] = [];
      let inDoc = false;

      // T4.14: expanded regex to capture modifiers, annotations, generics, throws, and varargs.
      // Matches lines like:
      //   public void foo(String x)
      //   public static <T> List<T> foo(@Nullable String... xs) throws IOException
      //   @Override public final void run()
      const methodRegex = /^(?:@\w+(?:\([^)]*\))?\s*)*\s*(?:public|protected)\s+(?:(?:static|final|synchronized|abstract|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:[\w<>?\[\],\s]+?)\s+(\w+)\s*\([^)]*\)(?:\s+throws\s+[\w.,\s]+)?\s*(?:;|\{|$)/;

      for (const line of lines) {
          const trimmed = line.trim();

          // Javadoc extraction
          if (trimmed.startsWith('/**')) {
              inDoc = true;
              currentDoc = [];
          }
          if (inDoc) {
              currentDoc.push(trimmed.replace(/^\/\*\*|\*\/|^\*\s?/g, '').trim());
          }
          if (trimmed.endsWith('*/')) {
              inDoc = false;
              if (currentDoc.length > 0) {
                 const docBlock = currentDoc.filter(s => s.length > 0).join('\n');
                 allDocs.push(docBlock);

                 // If we found a class doc (usually before class definition), keep it as primary doc
                 if (doc === "") {
                     doc = docBlock;
                 }
              }
          }

          // Method extraction
          const match = line.match(methodRegex);
          if (match) {
              let sig = match[0].trim();
              if (sig.endsWith('{')) sig = sig.slice(0, -1).trim();
              signatures.push(sig);
          } else {
              // T4.14: log unmatched lines that look like method signatures at debug level.
              // (only when the line contains "(" and ")" — heuristic for "looks like a method")
              if (trimmed.includes('(') && trimmed.includes(')') && /(?:public|protected)\b/.test(trimmed)) {
                  // Not a real log channel here; silently skip to avoid noise.
              }
          }
      }

      return {
          className,
          signatures,
          doc: type === 'docs' ? allDocs.join('\n\n') : undefined,
          language
      };
  }
}
