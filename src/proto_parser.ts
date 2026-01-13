
export interface ProtoInfo {
    javaPackage?: string;
    javaOuterClassname?: string;
    javaMultipleFiles?: boolean;
    package?: string;
    definitions: string[];
}

export class ProtoParser {
    public static parse(content: string): ProtoInfo {
        const info: ProtoInfo = {
            definitions: []
        };

        // Remove comments
        const cleanContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

        // Parse package
        const packageMatch = cleanContent.match(/package\s+([\w.]+)\s*;/);
        if (packageMatch) {
            info.package = packageMatch[1];
        }

        // Parse options
        const javaPackageMatch = cleanContent.match(/option\s+java_package\s*=\s*"([^"]+)"\s*;/);
        if (javaPackageMatch) {
            info.javaPackage = javaPackageMatch[1];
        }

        const javaOuterClassnameMatch = cleanContent.match(/option\s+java_outer_classname\s*=\s*"([^"]+)"\s*;/);
        if (javaOuterClassnameMatch) {
            info.javaOuterClassname = javaOuterClassnameMatch[1];
        }

        const javaMultipleFilesMatch = cleanContent.match(/option\s+java_multiple_files\s*=\s*(true|false)\s*;/);
        if (javaMultipleFilesMatch) {
            info.javaMultipleFiles = javaMultipleFilesMatch[1] === 'true';
        }

        // Parse definitions (message, enum, service)
        // We only care about top-level definitions. 
        // Simple regex might match nested ones too, but for indexing purposes, finding all declared names is usually fine.
        // However, to be precise for java_multiple_files, we should try to match top-level only.
        // But matching braces with regex is hard.
        // Let's assume standard formatting or just grab all "message X", "enum Y", "service Z".
        // If they are nested, they become Inner classes in Java anyway (if multiple_files=true, nested messages are still inner classes of the top-level message class).
        // So we strictly only care about TOP LEVEL definitions if we want to mimic java_multiple_files behavior correctly.
        // But detecting nesting is hard without a real parser.
        // For now, let's grab all and maybe filter? 
        // Actually, in proto, nested messages are defined *inside* the braces.
        
        // Let's try a slightly better regex approach that assumes top-level definitions start at the beginning of the line or after a closing brace.
        // Or simply scan and count braces? That's safer.
        
        info.definitions = ProtoParser.extractTopLevelDefinitions(cleanContent);

        return info;
    }

    private static extractTopLevelDefinitions(content: string): string[] {
        const definitions: string[] = [];
        let braceDepth = 0;
        const tokens = content.split(/([{}])|\s+/).filter(t => t && t.trim().length > 0);
        
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            
            if (token === '{') {
                braceDepth++;
            } else if (token === '}') {
                braceDepth--;
            } else if (braceDepth === 0) {
                // We are at top level
                if (['message', 'enum', 'service'].includes(token)) {
                    // Next token should be the name
                    if (i + 1 < tokens.length) {
                        const name = tokens[i+1];
                        // Validate name (alphanumeric)
                        if (/^\w+$/.test(name)) {
                            definitions.push(name);
                            // Skip the name so we don't process it again
                            i++; 
                        }
                    }
                }
            }
        }
        return definitions;
    }
}
