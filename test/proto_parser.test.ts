import { describe, it, expect } from 'vitest';
import { ProtoParser } from '../src/proto_parser.js';

describe('ProtoParser', () => {
    it('should parse full proto options and definitions', () => {
        const protoContent = `
syntax = "proto3";
package com.example;

option java_package = "com.example.gen";
option java_outer_classname = "MyProto";
option java_multiple_files = true;

message MyMessage {
  string id = 1;
}

enum MyEnum {
  VAL1 = 0;
}

service MyService {
  rpc Get(MyMessage) returns (MyMessage);
}
`;
        const info = ProtoParser.parse(protoContent);
        
        expect(info.package).toBe('com.example');
        expect(info.javaPackage).toBe('com.example.gen');
        expect(info.javaOuterClassname).toBe('MyProto');
        expect(info.javaMultipleFiles).toBe(true);
        expect(info.definitions).toContain('MyMessage');
        expect(info.definitions).toContain('MyEnum');
        expect(info.definitions).toContain('MyService');
        expect(info.definitions.length).toBe(3);
    });

    it('should parse simple proto options', () => {
        const simpleProto = `
package simple;
option java_package = "simple.gen";
`;
        const info = ProtoParser.parse(simpleProto);
        
        expect(info.javaPackage).toBe('simple.gen');
        expect(info.javaOuterClassname).toBeUndefined();
    });
});
