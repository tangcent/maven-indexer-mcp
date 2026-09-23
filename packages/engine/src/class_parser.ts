
import { CallEdge, walkInvokeEdges } from './bytecode_walker.js';

export interface ClassInfo {
    className: string;
    superClass?: string;
    interfaces: string[];
    methods?: string[];
    callEdges?: CallEdge[];
}

/** Thrown when the constant pool contains an unrecognized tag. */
export class UnknownTagError extends Error {
    public readonly tag: number;
    public readonly offset: number;

    constructor(tag: number, offset: number) {
        super(`Unknown constant pool tag: ${tag} at offset ${offset}`);
        this.name = 'UnknownTagError';
        this.tag = tag;
        this.offset = offset;
    }
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
                    this.offset += 4;
                    break;
                case 10: // Methodref
                case 11: // InterfaceMethodref
                    this.constantPool[i] = { tag, classIndex: this.readU2(), nameAndTypeIndex: this.readU2() };
                    break;
                case 12: // NameAndType
                    this.constantPool[i] = { tag, nameIndex: this.readU2(), descriptorIndex: this.readU2() };
                    break;
                case 15: // MethodHandle
                    this.offset += 3;
                    break;
                case 16: // MethodType
                    this.offset += 2;
                    break;
                case 17: // Dynamic
                case 18: // InvokeDynamic
                    this.constantPool[i] = { tag, bootstrapMethodAttrIndex: this.readU2(), nameAndTypeIndex: this.readU2() };
                    break;
                case 19: // Module
                case 20: // Package
                    this.offset += 2;
                    break;
                default:
                    throw new UnknownTagError(tag, this.offset - 1);
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

        // Skip fields (must advance offset to reach methods).
        const fieldsCount = this.readU2();
        for (let i = 0; i < fieldsCount; i++) {
            this.readU2(); // access_flags
            this.readU2(); // name_index
            this.readU2(); // descriptor_index
            const attributesCount = this.readU2();
            for (let j = 0; j < attributesCount; j++) {
                this.readU2(); // attribute_name_index
                const attributeLength = this.readU4();
                this.offset += attributeLength;
            }
        }

        // Read methods and collect their names (+ call edges when enabled).
        const methodsCount = this.readU2();
        const methods: string[] = [];
        const callEdges: CallEdge[] = [];
        const callGraphEnabled = process.env.INDEX_CALL_GRAPH !== '0';
        const dottedClassName = className.replace(/\//g, '.');

        for (let i = 0; i < methodsCount; i++) {
            this.readU2(); // access_flags
            const nameIndex = this.readU2();
            const descriptorIndex = this.readU2();
            const attributesCount = this.readU2();
            const methodName = this.getUtf8(nameIndex);
            const methodDescriptor = this.getUtf8(descriptorIndex);

            for (let j = 0; j < attributesCount; j++) {
                const attrNameIndex = this.readU2();
                const attributeLength = this.readU4();
                const attrBytesStart = this.offset;

                // When call-graph indexing is on, descend into the Code attribute
                // and walk the bytecode for invoke* edges.
                if (callGraphEnabled && methodName && attrBytesStart + attributeLength <= this.buffer.length) {
                    const attrName = this.getUtf8(attrNameIndex);
                    if (attrName === 'Code' && attrBytesStart + 8 <= this.buffer.length) {
                        try {
                            // Code layout: max_stack(u2), max_locals(u2), code_length(u4), code[code_length], ...
                            const codeLength = this.buffer.readUInt32BE(attrBytesStart + 4);
                            const codeStart = attrBytesStart + 8;
                            if (codeLength > 0 && codeStart + codeLength <= this.buffer.length) {
                                const code = this.buffer.subarray(codeStart, codeStart + codeLength);
                                const edges = walkInvokeEdges(code, this.constantPool, dottedClassName, methodName, methodDescriptor);
                                callEdges.push(...edges);
                            }
                        } catch (e) {
                            console.error(`Failed to walk Code attribute for ${dottedClassName}.${methodName}: ${e instanceof Error ? e.message : e}`);
                        }
                    }
                }
                // Always advance past the attribute bytes.
                this.offset = attrBytesStart + attributeLength;
            }

            if (methodName && methodName !== '<init>' && methodName !== '<clinit>') {
                methods.push(methodName);
            }
        }

        return {
            className: dottedClassName,
            superClass: superClass ? superClass.replace(/\//g, '.') : undefined,
            interfaces: interfaces.map(i => i.replace(/\//g, '.')),
            methods,
            callEdges: callGraphEnabled ? callEdges : undefined,
        };
    }

    private getUtf8(index: number): string | undefined {
        const entry = this.constantPool[index];
        if (!entry || entry.tag !== 1) {
            return undefined;
        }
        return entry.value;
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
