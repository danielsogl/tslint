/**
 * @license
 * Copyright 2013 Palantir Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

import {
    convertRuleOptions,
    DEFAULT_CONFIG,
    findConfiguration,
    findConfigurationPath,
    getRelativePath,
    getRulesDirectories,
    IConfigurationFile,
    loadConfigurationFromPath,
} from "./configuration";
import { removeDisabledFailures } from "./enableDisableRules";
import { FatalError, isError, showWarningOnce } from "./error";
import { findFormatter } from "./formatterLoader";
import { ILinterOptions, LintResult } from "./index";
import { IFormatter } from "./language/formatter/formatter";
import { IRule, isTypedRule, Replacement, RuleFailure, RuleSeverity } from "./language/rule/rule";
import * as utils from "./language/utils";
import { loadRules } from "./ruleLoader";
import { arrayify, dedent, flatMap } from "./utils";

/**
 * Linter that can lint multiple files in consecutive runs.
 */
class Linter {
    public static VERSION = "5.3.0";

    public static findConfiguration = findConfiguration;
    public static findConfigurationPath = findConfigurationPath;
    public static getRulesDirectories = getRulesDirectories;
    public static loadConfigurationFromPath = loadConfigurationFromPath;

    private failures: RuleFailure[] = [];
    private fixes: RuleFailure[] = [];

    /**
     * Creates a TypeScript program object from a tsconfig.json file path and optional project directory.
     */
    public static createProgram(configFile: string, projectDirectory: string = path.dirname(configFile)): ts.Program {
        const { config } = ts.readConfigFile(configFile, ts.sys.readFile);
        const parseConfigHost: ts.ParseConfigHost = {
            fileExists: fs.existsSync,
            readDirectory: ts.sys.readDirectory,
            readFile: (file) => fs.readFileSync(file, "utf8"),
            useCaseSensitiveFileNames: true,
        };
        const parsed = ts.parseJsonConfigFileContent(config, parseConfigHost, path.resolve(projectDirectory), {noEmit: true});
        const host = ts.createCompilerHost(parsed.options, true);
        const program = ts.createProgram(parsed.fileNames, parsed.options, host);

        return program;
    }

    /**
     * Returns a list of source file names from a TypeScript program. This includes all referenced
     * files and excludes declaration (".d.ts") files.
     */
    public static getFileNames(program: ts.Program): string[] {
        return program.getSourceFiles().map((s) => s.fileName).filter((l) => l.substr(-5) !== ".d.ts");
    }

    constructor(private options: ILinterOptions, private program?: ts.Program) {
        if (typeof options !== "object") {
            throw new Error(`Unknown Linter options type: ${typeof options}`);
        }
        if ((options as any).configuration != null) {
            throw new Error("ILinterOptions does not contain the property `configuration` as of version 4. " +
                "Did you mean to pass the `IConfigurationFile` object to lint() ? ");
        }
    }

    public lint(fileName: string, source: string, configuration: IConfigurationFile = DEFAULT_CONFIG): void {
        const sourceFile = this.getSourceFile(fileName, source);
        const isJs = /\.jsx?$/i.test(fileName);
        const enabledRules = this.getEnabledRules(configuration, isJs);

        let fileFailures = this.getAllFailures(sourceFile, enabledRules);
        if (fileFailures.length === 0) {
            // Usual case: no errors.
            return;
        }

        if (this.options.fix && fileFailures.some((f) => f.hasFix())) {
            fileFailures = this.applyAllFixes(enabledRules, fileFailures, sourceFile, fileName);
        }

        // add rule severity to failures
        const ruleSeverityMap = new Map(enabledRules.map((rule) => {
            return [rule.getOptions().ruleName, rule.getOptions().ruleSeverity] as [string, RuleSeverity];
        }));

        for (const failure of fileFailures) {
            const severity = ruleSeverityMap.get(failure.getRuleName());
            if (severity === undefined) {
                throw new Error(`Severity for rule '${failure.getRuleName()}' not found`);
            }
            failure.setRuleSeverity(severity);
        }

        this.failures = this.failures.concat(fileFailures);
    }

    public getResult(): LintResult {
        let formatter: IFormatter;
        const formattersDirectory = getRelativePath(this.options.formattersDirectory);

        const formatterName = this.options.formatter !== undefined ? this.options.formatter : "prose";
        const Formatter = findFormatter(formatterName, formattersDirectory);
        if (Formatter !== undefined) {
            formatter = new Formatter();
        } else {
            throw new Error(`formatter '${formatterName}' not found`);
        }

        const output = formatter.format(this.failures, this.fixes);

        const errorCount = this.failures.filter((failure) => failure.getRuleSeverity() === "error").length;
        return {
            errorCount,
            failures: this.failures,
            fixes: this.fixes,
            format: formatterName,
            output,
            warningCount: this.failures.length - errorCount,
        };
    }

    private getAllFailures(sourceFile: ts.SourceFile, enabledRules: IRule[]): RuleFailure[] {
        const failures = flatMap(enabledRules, (rule) => this.applyRule(rule, sourceFile));
        return removeDisabledFailures(sourceFile, failures);
    }

    private applyAllFixes(
            enabledRules: IRule[], fileFailures: RuleFailure[], sourceFile: ts.SourceFile, sourceFileName: string): RuleFailure[] {
        // When fixing, we need to be careful as a fix in one rule may affect other rules.
        // So fix each rule separately.
        let source: string = sourceFile.text;

        for (const rule of enabledRules) {
            const hasFixes = fileFailures.some((f) => f.hasFix() && f.getRuleName() === rule.getOptions().ruleName);
            if (hasFixes) {
                // Get new failures in case the file changed.
                const updatedFailures = removeDisabledFailures(sourceFile, this.applyRule(rule, sourceFile));
                const fixableFailures = updatedFailures.filter((f) => f.hasFix());
                this.fixes = this.fixes.concat(fixableFailures);
                source = this.applyFixes(sourceFileName, source, fixableFailures);
                sourceFile = this.getSourceFile(sourceFileName, source);
            }
        }

        // If there were fixes, get the *new* list of failures.
        return this.getAllFailures(sourceFile, enabledRules);
    }

    // Only "protected" because a test directly accesses it.
    // tslint:disable-next-line member-ordering
    protected applyFixes(sourceFilePath: string, source: string, fixableFailures: RuleFailure[]): string {
        const fixesByFile = createMultiMap(fixableFailures, (f) => [f.getFileName(), f.getFix()!]);
        fixesByFile.forEach((fileFixes, filePath) => {
            let fileNewSource: string;
            if (path.resolve(filePath) === path.resolve(sourceFilePath)) {
                source = Replacement.applyFixes(source, fileFixes);
                fileNewSource = source;
            } else {
                const oldSource = fs.readFileSync(filePath, "utf-8");
                fileNewSource = Replacement.applyFixes(oldSource, fileFixes);
            }
            fs.writeFileSync(filePath, fileNewSource, "utf-8");
        });

        return source;
    }

    private applyRule(rule: IRule, sourceFile: ts.SourceFile): RuleFailure[] {
        try {
            if (this.program !== undefined && isTypedRule(rule)) {
                return rule.applyWithProgram(sourceFile, this.program);
            } else {
                return rule.apply(sourceFile);
            }
        } catch (error) {
            if (isError(error)) {
                showWarningOnce(`Warning: ${error.message}`);
            } else {
                console.warn(`Warning: ${error}`);
            }
            return [];
        }
    }

    private getEnabledRules(configuration: IConfigurationFile = DEFAULT_CONFIG, isJs: boolean): IRule[] {
        const ruleOptionsList = convertRuleOptions(isJs ? configuration.jsRules : configuration.rules);
        const rulesDirectories = arrayify(this.options.rulesDirectory)
            .concat(arrayify(configuration.rulesDirectory));
        return loadRules(ruleOptionsList, rulesDirectories, isJs);
    }

    private getSourceFile(fileName: string, source: string) {
        if (this.program !== undefined) {
            const sourceFile = this.program.getSourceFile(fileName);
            if (sourceFile === undefined) {
                const INVALID_SOURCE_ERROR = dedent`
                    Invalid source file: ${fileName}. Ensure that the files supplied to lint have a .ts, .tsx, .d.ts, .js or .jsx extension.
                `;
                throw new FatalError(INVALID_SOURCE_ERROR);
            }
            return sourceFile;
        } else {
            return utils.getSourceFile(fileName, source);
        }
    }
}

// tslint:disable-next-line:no-namespace
namespace Linter { }

export = Linter;

function createMultiMap<T, K, V>(inputs: T[], getPair: (input: T) => [K, V] | undefined): Map<K, V[]> {
    const map = new Map<K, V[]>();
    for (const input of inputs) {
        const pair = getPair(input);
        if (pair !== undefined) {
            const [k, v] = pair;
            const vs = map.get(k);
            if (vs !== undefined) {
                vs.push(v);
            } else {
                map.set(k, [v]);
            }
        }
    }
    return map;
}
