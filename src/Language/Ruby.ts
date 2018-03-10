"use strict";

import * as _ from "lodash";
const unicode = require("unicode-properties");

import { TypeGraph } from "../TypeGraph";
import { Sourcelike, modifySource } from "../Source";
import { intercalate } from "../Support";
import { Namer, Name } from "../Naming";
import { ConvenienceRenderer, ForbiddenWordsInfo } from "../ConvenienceRenderer";
import { TargetLanguage } from "../TargetLanguage";
import { Option } from "../RendererOptions";

import {
    Type,
    EnumType,
    ClassType,
    nullableFromUnion,
    matchType,
    UnionType,
    removeNullFromUnion,
    ArrayType,
    MapType,
    ClassProperty
} from "../Type";

import {
    legalizeCharacters,
    splitIntoWords,
    combineWords,
    firstUpperWordStyle,
    allUpperWordStyle,
    allLowerWordStyle,
    utf32ConcatMap,
    isPrintable,
    escapeNonPrintableMapper,
    intToHex
} from "../Strings";

const keywords = [
    "Object",
    "__ENCODING__",
    "__FILE__",
    "__LINE__",
    "alias",
    "and",
    "begin",
    "BEGIN",
    "break",
    "case",
    "class",
    "def",
    "defined?",
    "do",
    "else",
    "elsif",
    "end",
    "END",
    "ensure",
    "false",
    "for",
    "if",
    "in",
    "module",
    "next",
    "nil",
    "not",
    "or",
    "redo",
    "rescue",
    "retry",
    "return",
    "self",
    "super",
    "then",
    "true",
    "undef",
    "unless",
    "until",
    "when",
    "while",
    "yield"
];

function unicodeEscape(codePoint: number): string {
    return "\\u{" + intToHex(codePoint, 0) + "}";
}

const stringEscape = utf32ConcatMap(escapeNonPrintableMapper(isPrintable, unicodeEscape));

export default class RubyTargetLanguage extends TargetLanguage {
    constructor() {
        super("Ruby", ["ruby"], "rb");
    }

    protected getOptions(): Option<any>[] {
        return [];
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    protected get defaultIndentation(): string {
        return "  ";
    }

    protected get rendererClass(): new (
        graph: TypeGraph,
        leadingComments: string[] | undefined,
        ...optionValues: any[]
    ) => ConvenienceRenderer {
        return RubyRenderer;
    }
}

function isStartCharacter(utf16Unit: number): boolean {
    return unicode.isAlphabetic(utf16Unit) || utf16Unit === 0x5f; // underscore
}

function isPartCharacter(utf16Unit: number): boolean {
    const category: string = unicode.getCategory(utf16Unit);
    return _.includes(["Nd", "Pc", "Mn", "Mc"], category) || isStartCharacter(utf16Unit);
}

const legalizeName = legalizeCharacters(isPartCharacter);

function simpleNameStyle(original: string, uppercase: boolean): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        uppercase ? firstUpperWordStyle : allLowerWordStyle,
        uppercase ? firstUpperWordStyle : allLowerWordStyle,
        allUpperWordStyle,
        allUpperWordStyle,
        "",
        isStartCharacter
    );
}

function memberNameStyle(original: string): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        allLowerWordStyle,
        allLowerWordStyle,
        allLowerWordStyle,
        allLowerWordStyle,
        "_",
        isStartCharacter
    );
}

class RubyRenderer extends ConvenienceRenderer {
    constructor(graph: TypeGraph, leadingComments: string[] | undefined) {
        super(graph, leadingComments);
    }

    protected get commentLineStart(): string {
        return "# ";
    }

    protected get needsTypeDeclarationBeforeUse(): boolean {
        return true;
    }

    protected topLevelNameStyle(rawName: string): string {
        return simpleNameStyle(rawName, true);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Object"];
    }

    protected forbiddenForClassProperties(_c: ClassType, _classNamed: Name): ForbiddenWordsInfo {
        return { names: keywords, includeGlobalForbidden: true };
    }

    protected makeNamedTypeNamer(): Namer {
        return new Namer("types", n => simpleNameStyle(n, true), []);
    }

    protected namerForClassProperty(): Namer {
        return new Namer("properties", memberNameStyle, []);
    }

    protected makeUnionMemberNamer(): Namer {
        return new Namer("properties", memberNameStyle, []);
    }

    protected makeEnumCaseNamer(): Namer {
        return new Namer("enum-cases", n => simpleNameStyle(n, true), []);
    }

    private dryType(t: Type, isOptional: boolean = false): Sourcelike {
        const optional = isOptional ? ".optional" : "";
        return matchType<Sourcelike>(
            t,
            _anyType => ["Types::Any", optional],
            _nullType => ["Types::Nil", optional],
            _boolType => ["Types::Strict::Bool", optional],
            _integerType => ["Types::Strict::Int", optional],
            // TODO make this accept float and int
            _doubleType => ["Types::Decimal", optional],
            _stringType => ["Types::Strict::String", optional],
            arrayType => ["Types.Array(", this.dryType(arrayType.items), ")", optional],
            classType => ["Types.Instance(", this.nameForNamedType(classType), ")", optional],
            mapType => ["Types::Strict::Hash.meta(of: ", this.dryType(mapType.values), ")", optional],
            enumType => ["Types::", this.nameForNamedType(enumType), optional],
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return [this.dryType(nullable), ".optional"];
                }
                if (this.marshalsImplicitly(unionType)) {
                    const children = unionType.children.map(child => this.dryType(child));
                    const union = intercalate(" | ", children).toArray();
                    return isOptional ? ["(", union, ")", optional] : union;
                }
                return ["Types.Instance(", this.nameForNamedType(unionType), ")", optional];
            }
        );
    }

    private exampleUse(t: Type, exp: Sourcelike, depth: number = 6, optional: boolean = false): Sourcelike {
        if (depth-- <= 0) {
            return exp;
        }

        const safeNav = optional ? "&" : "";

        return matchType<Sourcelike>(
            t,
            _anyType => exp,
            _nullType => [exp, ".nil?"],
            _boolType => exp,
            _integerType => [exp, ".even?"],
            _doubleType => exp,
            _stringType => exp,
            arrayType => this.exampleUse(arrayType.items, [exp, safeNav, ".first"], depth),
            classType => {
                let info: { name: Name; prop: ClassProperty } | undefined;
                this.forEachClassProperty(classType, "none", (name, _json, prop) => {
                    if (["class", "map", "array"].indexOf(prop.type.kind) >= 0) {
                        info = { name, prop };
                    } else {
                        info = info || { name, prop };
                    }
                });
                if (info !== undefined) {
                    return this.exampleUse(info.prop.type, [exp, safeNav, ".", info.name], depth, info.prop.isOptional);
                }
                return exp;
            },
            mapType => this.exampleUse(mapType.values, [exp, safeNav, `["…"]`], depth),
            enumType => {
                let name: Name | undefined;
                this.forEachEnumCase(enumType, "none", theName => {
                    name = name || theName;
                });
                if (name !== undefined) {
                    return [exp, " == ", this.nameForNamedType(enumType), "::", name];
                }
                return exp;
            },
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    if (["class", "map", "array"].indexOf(nullable.kind) >= 0) {
                        return this.exampleUse(nullable, exp, depth, true);
                    }
                    return [exp, ".nil?"];
                }
                return exp;
            }
        );
    }

    private jsonSample(t: Type): Sourcelike {
        function inner() {
            if (t instanceof ArrayType) {
                return "[…]";
            } else if (t instanceof MapType) {
                return "{…}";
            } else if (t instanceof ClassType) {
                return "{…}";
            } else {
                return "…";
            }
        }
        return `"${inner()}"`;
    }

    private fromDynamic(t: Type, e: Sourcelike, optional: boolean = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => e,
            _nullType => e,
            _boolType => e,
            _integerType => e,
            _doubleType => e,
            _stringType => e,
            arrayType => [e, optional ? "&" : "", ".map { |x| ", this.fromDynamic(arrayType.items, "x"), " }"],
            classType => {
                const expression = [this.nameForNamedType(classType), ".from_dynamic!(", e, ")"];
                return optional ? [e, " ? ", expression, " : nil"] : expression;
            },
            mapType => [
                e,
                optional ? "&" : "",
                ".map { |k, v| [k, ",
                this.fromDynamic(mapType.values, "v"),
                "] }.to_h"
            ],
            enumType => {
                const expression = ["Types::", this.nameForNamedType(enumType), "[", e, "]"];
                return optional ? [e, ".nil? ? nil : ", expression] : expression;
            },
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return [e, ".nil? ? nil : ", this.fromDynamic(nullable, e)];
                }
                if (this.marshalsImplicitly(unionType)) {
                    return e;
                }
                const expression = [this.nameForNamedType(unionType), ".from_dynamic!(", e, ")"];
                return optional ? [e, " ? ", expression, " : nil"] : expression;
            }
        );
    }

    private toDynamic(t: Type, e: Sourcelike, optional: boolean = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => e,
            _nullType => e,
            _boolType => e,
            _integerType => e,
            _doubleType => e,
            _stringType => e,
            arrayType => [e, optional ? "&" : "", ".map { |x| ", this.toDynamic(arrayType.items, "x"), " }"],
            _classType => [e, optional ? "&" : "", ".to_dynamic"],
            mapType => [e, optional ? "&" : "", ".map { |k, v| [k, ", this.toDynamic(mapType.values, "v"), "] }.to_h"],
            _enumType => e,
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return [e, ".nil? ? nil : ", this.toDynamic(nullable, e)];
                }
                if (this.marshalsImplicitly(unionType)) {
                    return e;
                }
                return [e, optional ? "&" : "", ".to_dynamic"];
            }
        );
    }

    private marshalsImplicitly(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => true,
            _nullType => true,
            _boolType => true,
            _integerType => true,
            _doubleType => true,
            _stringType => true,
            arrayType => this.marshalsImplicitly(arrayType.items),
            _classType => false,
            _mapType => false,
            _enumType => true,
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return this.marshalsImplicitly(nullable);
                }
                return unionType.children.every(child => this.marshalsImplicitly(child));
            }
        );
    }

    private emitBlock(source: Sourcelike, emit: () => void) {
        this.emitLine(source);
        this.indent(emit);
        this.emitLine("end");
    }

    private emitClass(c: ClassType, className: Name) {
        this.emitDescription(this.descriptionForType(c));
        this.emitBlock(["class ", className, " < Dry::Struct"], () => {
            let table: Sourcelike[][] = [];
            let count = c.properties.count();
            this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                const last = --count === 0;
                const description = this.descriptionForClassProperty(c, jsonName);
                const attribute = [
                    ["attribute :", name, ","],
                    [" ", this.dryType(p.type), p.isOptional ? ".optional" : ""]
                ];
                if (description !== undefined) {
                    if (table.length > 0) {
                        this.emitTable(table);
                        table = [];
                    }
                    this.ensureBlankLine();
                    this.emitDescriptionBlock(description);
                    this.emitLine(attribute);
                    if (!last) {
                        this.ensureBlankLine();
                    }
                } else {
                    table.push(attribute);
                }
            });
            if (table.length > 0) {
                this.emitTable(table);
            }

            this.ensureBlankLine();
            this.emitBlock(["def self.from_dynamic!(d)"], () => {
                this.emitLine("new(");
                this.indent(() => {
                    const inits: Sourcelike[][] = [];
                    this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                        const dynamic = `d["${stringEscape(jsonName)}"]`;

                        let expression: Sourcelike;
                        if (this.marshalsImplicitly(p.type)) {
                            expression = dynamic;
                        } else {
                            expression = this.fromDynamic(p.type, dynamic, p.isOptional);
                        }

                        inits.push([[name, ": "], [expression, ","]]);
                    });
                    this.emitTable(inits);
                });
                this.emitLine(")");
            });

            this.ensureBlankLine();
            this.emitBlock("def self.from_json!(json)", () => {
                this.emitLine("from_dynamic!(JSON.parse(json))");
            });

            this.ensureBlankLine();
            this.emitBlock(["def to_dynamic"], () => {
                this.emitLine("{");
                this.indent(() => {
                    const inits: Sourcelike[][] = [];
                    this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                        const dynamic = ["@", name];

                        let expression: Sourcelike;
                        if (this.marshalsImplicitly(p.type)) {
                            expression = dynamic;
                        } else {
                            expression = this.toDynamic(p.type, dynamic, p.isOptional);
                        }

                        inits.push([[`"${stringEscape(jsonName)}"`], [" => ", expression, ","]]);
                    });
                    this.emitTable(inits);
                });
                this.emitLine("}");
            });
            this.ensureBlankLine();
            this.emitBlock("def to_json(options = nil)", () => {
                this.emitLine("JSON.generate(to_dynamic, options)");
            });
        });
    }

    private emitEnum(e: EnumType, enumName: Name) {
        this.emitDescription(this.descriptionForType(e));
        this.emitBlock(["module ", enumName], () => {
            const table: Sourcelike[][] = [];
            this.forEachEnumCase(e, "none", (name, json) => {
                table.push([[name], [` = "${stringEscape(json)}"`]]);
            });
            this.emitTable(table);
        });
    }

    private emitUnion(u: UnionType, unionName: Name) {
        // Implicitly marshaled unions don't get a struct container
        if (this.marshalsImplicitly(u)) {
            return;
        }

        this.emitDescription(this.descriptionForType(u));
        this.emitBlock(["class ", unionName, " < Dry::Struct"], () => {
            const table: Sourcelike[][] = [];
            const [maybeNull, nonNulls] = removeNullFromUnion(u, true);
            this.forEachUnionMember(u, nonNulls, "none", null, (name, t) => {
                table.push([["attribute :", name, ", "], [this.dryType(t, true)]]);
            });
            if (maybeNull !== null) {
                table.push([["attribute :", this.nameForUnionMember(u, maybeNull), ", "], [this.dryType(maybeNull)]]);
            }
            this.emitTable(table);

            this.ensureBlankLine();
            this.emitBlock("def self.from_dynamic!(d)", () => {
                // const instance = modifySource(_.snakeCase, unionName);
                const instance = "union";
                this.emitLine(instance, " = new(");
                this.indent(() => {
                    this.forEachUnionMember(u, nonNulls, "none", null, (name, t) => {
                        this.emitLine(name, ":");
                        this.indent(() => {
                            this.emitLine("begin schema[:", name, "][", this.fromDynamic(t, "d"), "] rescue nil end,");
                        });
                    });
                });
                this.emitLine(")");
                this.emitLine(
                    `raise "Invalid union" unless `,
                    instance,
                    `.__attributes__.count { |k, v| not v.nil? } == 1`
                );
                this.emitLine(instance);
            });

            this.ensureBlankLine();
            this.emitBlock("def self.from_json!(json)", () => {
                this.emitLine("from_dynamic!(JSON.parse(json))");
            });

            this.ensureBlankLine();
            this.emitBlock("def to_dynamic", () => {
                let first = true;
                this.forEachUnionMember(u, nonNulls, "none", null, (name, t) => {
                    this.emitLine(first ? "if" : "elsif", " @", name, " != nil");
                    this.indent(() => {
                        this.emitLine("then ", this.toDynamic(t, ["@", name]));
                    });
                    first = false;
                });
                this.indent(() => {
                    this.emitLine("end");
                });
            });

            this.ensureBlankLine();
            this.emitBlock("def to_json(options = nil)", () => {
                this.emitLine("JSON.generate(to_dynamic, options)");
            });
        });
    }

    private emitEnumDeclaration(e: EnumType, name: Name) {
        const cases: Sourcelike[][] = [];
        this.forEachEnumCase(e, "none", (_name, json) => {
            cases.push([cases.length === 0 ? "" : ", ", `"${stringEscape(json)}"`]);
        });
        this.emitLine(name, " = Types::Strict::String.enum(", ...cases, ")");
    }

    protected emitSourceStructure() {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
        } else {
            this.emitLine("# This code may look unusually verbose for Ruby (and it is), but");
            this.emitLine("# it performs some subtle and complex validation of JSON data.");
            this.emitLine("#");
            this.emitLine("# To parse this JSON, add 'dry-struct' and 'dry-types' gems, then do:");
            this.emitLine("#");
            this.forEachTopLevel("none", (topLevel, name) => {
                const variable = modifySource(_.snakeCase, name);
                this.emitLine("#   ", variable, " = ", name, ".from_json! ", this.jsonSample(topLevel));
                this.emitLine("#   puts ", this.exampleUse(topLevel, variable));
                this.emitLine("#");
            });
            this.emitLine("# If from_json! succeeds, the value returned matches the schema.");
        }
        this.ensureBlankLine();

        this.emitLine("require 'json'");
        this.emitLine("require 'dry-types'");
        this.emitLine("require 'dry-struct'");
        this.ensureBlankLine();

        this.emitBlock(["module Types"], () => {
            this.emitLine("include Dry::Types.module");
            this.forEachNamedType(
                "none",
                (_c, _n) => undefined,
                (e, n) => this.emitEnumDeclaration(e, n),
                (_u, _n) => undefined
            );
        });

        this.forEachNamedType(
            "leading-and-interposing",
            (c, n) => this.emitClass(c, n),
            (e, n) => this.emitEnum(e, n),
            (u, n) => this.emitUnion(u, n)
        );

        this.forEachTopLevel(
            "leading-and-interposing",
            (topLevel, name) => {
                const self = modifySource(_.snakeCase, name);
                this.emitBlock(["class ", name], () => {
                    this.emitBlock(["def self.from_json!(json)"], () => {
                        this.emitLine(self, " = ", this.fromDynamic(topLevel, "JSON.parse(json)"));
                        this.emitBlock([self, ".define_singleton_method(:to_json) do"], () => {
                            this.emitLine("JSON.generate(", this.toDynamic(topLevel, "self"), ")");
                        });
                        this.emitLine(self);
                    });
                });
            },
            t => this.namedTypeToNameForTopLevel(t) === undefined
        );
    }
}
