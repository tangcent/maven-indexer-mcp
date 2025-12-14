import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Config } from './config.js';

const execAsync = promisify(exec);

export interface ClassDetail {
  className: string;
  source?: string;
  signatures?: string[];
  doc?: string;
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
    const internalPath = className.replace(/\./g, '/') + '.java';
    
    return new Promise((resolve, reject) => {
        yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
            if (err || !zipfile) {
                resolve(null);
                return;
            }

            let found = false;

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                if (entry.fileName === internalPath) {
                    found = true;
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err || !readStream) {
                            resolve(null);
                            return;
                        }

                        const chunks: Buffer[] = [];
                        readStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                        readStream.on('end', () => {
                            const source = Buffer.concat(chunks).toString('utf-8');
                            resolve(SourceParser.parse(className, source, type));
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
  }

  private static async getSignaturesWithJavap(jarPath: string, className: string): Promise<ClassDetail | null> {
    try {
      const config = await Config.getInstance();
      const javap = config.getJavapPath();
      
      // Use -public to show public members (closest to API surface)
      // or default (protected)
      const { stdout } = await execAsync(`"${javap}" -cp "${jarPath}" "${className}"`);
      
      const lines = stdout.split('\n')
        .map(l => l.trim())
        .filter(l => 
          l.length > 0 && 
          !l.startsWith('Compiled from') && 
          !l.includes('static {};') &&
          l !== '}'
        );
      
      return {
        className,
        signatures: lines
      };
    } catch (e) {
      // Fallback or error
      // If javap fails (e.g. class not found in main jar?), return null
      // console.error(`javap failed for ${className} in ${jarPath}:`, e);
      return null;
    }
  }

  private static parse(className: string, source: string, type: 'signatures' | 'docs' | 'source'): ClassDetail {
      if (type === 'source') {
          return { className, source };
      }

      // Very simple regex-based parsing to extract methods and javadocs
      // This is heuristic and won't be perfect, but it's fast and dependency-free
      const signatures: string[] = [];
      let doc = "";
      const allDocs: string[] = [];

      const lines = source.split('\n');
      let currentDoc: string[] = [];
      let inDoc = false;

      // Regex to match method signatures (public/protected, return type, name, args)
      // ignoring annotations for simplicity
      const methodRegex = /^\s*(public|protected)\s+(?:[\w<>?\[\]]+\s+)+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,.\s]+)?\s*\{?/;

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
              // match[0] is the whole line up to {
              // Clean it up
              let sig = match[0].trim();
              if (sig.endsWith('{')) sig = sig.slice(0, -1).trim();
              signatures.push(sig);
          }
      }

      return {
          className,
          signatures,
          doc: type === 'docs' ? allDocs.join('\n\n') : undefined
      };
  }
}
