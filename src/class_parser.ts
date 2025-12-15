
export interface ClassInfo {
    className: string;
    superClass?: string;
    interfaces: string[];
}

export class ClassParser {
    private buffer: Buffer;
    private offset: number = 0;
    private constantPool: any[] = [];

    constructor(buffer: Buffer) {
        this.buffer = buffer;
    }

    public static parse(buffer: Buffer): ClassInfo {
        const parser = new ClassParser(buffer);
        return parser.parse();
    }

    private parse(): ClassInfo {
        if (this.buffer.length < 10) {
            throw new Error("Invalid class file: too short");
        }

        const magic = this.readU4();
        if (magic !== 0xCAFEBABE) {
            throw new Error("Invalid magic number");
        }

        this.readU2(); // minor
        this.readU2(); // major

        const cpCount = this.readU2();
        this.constantPool = new Array(cpCount);

        // Constant Pool is 1-indexed (1 to count-1)
        for (let i = 1; i < cpCount; i++) {
            const tag = this.readU1();
            switch (tag) {
                case 1: // UTF8
                    const len = this.readU2();
                    const str = this.buffer.toString('utf-8', this.offset, this.offset + len);
                    this.offset += len;
                    this.constantPool[i] = { tag, value: str };
                    break;
                case 3: // Integer
                case 4: // Float
                    this.offset += 4;
                    break;
                case 5: // Long
                case 6: // Double
                    this.offset += 8;
                    i++; // Takes two slots
                    break;
                case 7: // Class
                    const nameIndex = this.readU2();
                    this.constantPool[i] = { tag, nameIndex };
                    break;
                case 8: // String
                    this.offset += 2;
                    break;
                case 9: // Fieldref
                case 10: // Methodref
                case 11: // InterfaceMethodref
                    this.offset += 4;
                    break;
                case 12: // NameAndType
                    this.offset += 4;
                    break;
                case 15: // MethodHandle
                    this.offset += 3;
                    break;
                case 16: // MethodType
                    this.offset += 2;
                    break;
                case 17: // Dynamic
                case 18: // InvokeDynamic
                    this.offset += 4;
                    break;
                case 19: // Module
                case 20: // Package
                    this.offset += 2;
                    break;
                default:
                    throw new Error(`Unknown constant pool tag: ${tag} at offset ${this.offset - 1}`);
            }
        }

        this.readU2(); // Access flags

        const thisClassIndex = this.readU2();
        const superClassIndex = this.readU2();

        const className = this.resolveClass(thisClassIndex);
        const superClass = superClassIndex === 0 ? undefined : this.resolveClass(superClassIndex);

        const interfacesCount = this.readU2();
        const interfaces: string[] = [];
        for (let i = 0; i < interfacesCount; i++) {
            const interfaceIndex = this.readU2();
            interfaces.push(this.resolveClass(interfaceIndex));
        }

        return {
            className: className.replace(/\//g, '.'),
            superClass: superClass ? superClass.replace(/\//g, '.') : undefined,
            interfaces: interfaces.map(i => i.replace(/\//g, '.'))
        };
    }

    private resolveClass(index: number): string {
        const entry = this.constantPool[index];
        if (!entry || entry.tag !== 7) {
            // Fallback or error?
             return "Unknown";
        }
        const nameEntry = this.constantPool[entry.nameIndex];
        if (!nameEntry || nameEntry.tag !== 1) {
            return "Unknown";
        }
        return nameEntry.value;
    }

    private readU1(): number {
        const val = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return val;
    }

    private readU2(): number {
        const val = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return val;
    }

    private readU4(): number {
        const val = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return val;
    }
}
