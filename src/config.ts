import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import xml2js from 'xml2js';
import { fileURLToPath } from 'url';

export class Config {
  private static instance: Config;
  public localRepository: string = "";
  public javaBinary: string = "java";
  public includedPackages: string[] = ["*"];
  public cfrPath: string | null = null;

  private constructor() {}

  public static async getInstance(): Promise<Config> {
    if (!Config.instance) {
      Config.instance = new Config();
      await Config.instance.load();
    }
    return Config.instance;
  }

  // For testing
  public static reset() {
    (Config as any).instance = undefined;
  }

  private async load() {
    let repoPath: string | null = null;

    // 1. Check environment variable
    if (process.env.MAVEN_REPO_PATH) {
      repoPath = process.env.MAVEN_REPO_PATH;
    } else if (process.env.MAVEN_REPO) {
      repoPath = process.env.MAVEN_REPO;
    }

    // 2. Try user settings
    if (!repoPath) {
      const homeDir = os.homedir();
      const userSettingsPath = path.join(homeDir, '.m2', 'settings.xml');
      
      if (await this.fileExists(userSettingsPath)) {
        repoPath = await this.parseSettings(userSettingsPath);
      }
    }

    // 3. Try global settings if not found
    if (!repoPath && process.env.M2_HOME) {
      const globalSettingsPath = path.join(process.env.M2_HOME, 'conf', 'settings.xml');
      if (await this.fileExists(globalSettingsPath)) {
        repoPath = await this.parseSettings(globalSettingsPath);
      }
    }

    // 4. Default
    if (!repoPath) {
      repoPath = path.join(os.homedir(), '.m2', 'repository');
    }

    this.localRepository = repoPath;

    // Load Java Path
    if (process.env.JAVA_HOME) {
      this.javaBinary = path.join(process.env.JAVA_HOME, 'bin', 'java');
    }
    // Allow explicit override
    if (process.env.JAVA_PATH) {
      this.javaBinary = process.env.JAVA_PATH;
    }

    // Load Included Packages
    if (process.env.INCLUDED_PACKAGES) {
      this.includedPackages = process.env.INCLUDED_PACKAGES.split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);
    }

    // Load CFR Path
    if (process.env.MAVEN_INDEXER_CFR_PATH) {
        this.cfrPath = process.env.MAVEN_INDEXER_CFR_PATH;
    } else {
        // Fallback to default bundled lib
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        this.cfrPath = path.resolve(__dirname, '../lib/cfr-0.152.jar');
    }

    if (this.cfrPath && !(await this.fileExists(this.cfrPath))) {
        try {
            console.error(`CFR jar not found at ${this.cfrPath}, attempting to download...`);
            await this.downloadCfr(this.cfrPath);
            console.error(`Successfully downloaded CFR jar to ${this.cfrPath}`);
        } catch (e: any) {
             console.error(`Failed to download CFR jar: ${e.message}`);
        }
    }

    // Log to stderr so it doesn't interfere with MCP protocol on stdout
    console.error(`Using local repository: ${this.localRepository}`);
    console.error(`Using Java binary: ${this.javaBinary}`);
    console.error(`Included packages: ${JSON.stringify(this.includedPackages)}`);
    if (this.cfrPath) {
        console.error(`Using CFR jar: ${this.cfrPath}`);
    }
  }

  public getCfrJarPath(): string | null {
      return this.cfrPath;
  }

  public getJavapPath(): string {
    if (this.javaBinary === 'java') return 'javap';
    const dir = path.dirname(this.javaBinary);
    return path.join(dir, 'javap');
  }

  private async downloadCfr(destPath: string): Promise<void> {
    const url = "https://github.com/tangcent/maven-indexer-mcp/raw/refs/heads/main/lib/cfr-0.152.jar";
    const dir = path.dirname(destPath);
    
    await fs.mkdir(dir, { recursive: true });

    return new Promise((resolve, reject) => {
        const download = (currentUrl: string) => {
            https.get(currentUrl, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    if (response.headers.location) {
                        download(response.headers.location);
                        return;
                    }
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download CFR jar: Status Code ${response.statusCode}`));
                    return;
                }

                const file = createWriteStream(destPath);
                response.pipe(file);
                file.on('finish', () => {
                    // @ts-ignore
                    file.close();
                    resolve();
                });
                file.on('error', (err) => {
                     fs.unlink(destPath).catch(() => {});
                     reject(err);
                });
            }).on('error', (err) => {
                reject(err);
            });
        };
        download(url);
    });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async parseSettings(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(content);
      
      if (result.settings && result.settings.localRepository && result.settings.localRepository[0]) {
        return result.settings.localRepository[0];
      }
    } catch (error) {
      console.error(`Failed to parse ${filePath}:`, error);
    }
    return null;
  }
}
