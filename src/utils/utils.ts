import { basename } from "path";
"use strict";
import * as fs from "fs";
import * as YAML from "yamljs";
import * as cp from "child_process";
import  jsesc from "jsesc";
// import { CompleterResult } from "readline";
// import { error } from "util";
import * as path from "path";
import {
  ExtensionContext,
  Position,
  Range,
  TextDocument,
  workspace,
  window,
  DiagnosticCollection
} from "vscode";

export interface ISnippet {
  [predIndicator: string]: {
    prefix: string;
    body: string[];
    description: string;
  };
}
interface IPredModule {
  [predicate: string]: string[];
}
export interface IPredicate {
  wholePred: string;
  pi: string;
  functor: string;
  arity: number;
  params: string;
  module: string;
}

export class Utils {
  public static snippets: ISnippet = null;
  public static newsnippets = [];
  private static predModules: IPredModule = null;
  public static DIALECT: string | null = null;
  public static RUNTIMEPATH: string | null = null;
  public static CONTEXT: ExtensionContext | null = null;
  public static LINTERTRIGGER: string | null = null;
  public static FORMATENABLED: boolean;
  public static EXPATH: string | null = null;

  constructor() { }
  public static getPredDescriptions(pred: string): string {
    if (Utils.snippets[pred]) {
      return Utils.snippets![pred].description;
    }
    return "";
  }
  // initialisation of utils class and load snippets file with it's predicates
  public static init(context: ExtensionContext) {
    Utils.CONTEXT = context;
    Utils.loadSnippets(context);
    Utils.genPredicateModules(context);
  }
  // load the snippets from file
  private static loadSnippets(context: ExtensionContext) {
    if (Utils.snippets) {
      return;
    }
    let snippetsPath = context.extensionPath + "/snippets/prolog.json";
    let snippets = fs.readFileSync(snippetsPath, "utf8").toString();
    Utils.snippets = JSON.parse(snippets);
  }
  // initialise module for predicates from the loaded snippets
  public static genPredicateModules(context: ExtensionContext) {
    Utils.predModules = <IPredModule>new Object();
    let pred, mod: string;
    for (let p in Utils.snippets) { // from the loaded snippets
      if (p.indexOf(":") > 0) {
        [mod, pred] = p.split(":");
        if (Utils.predModules[pred]) { // if predicates have severals modules
          Utils.predModules[pred] = Utils.predModules[pred].concat(mod);
        } else {
          Utils.predModules[pred] = [mod];
        }
      }
    }
  }
  // return the module of a specified predicate
  public static getPredModules(pred1: string): string[] {
    let pred = pred1.indexOf(":") > -1 ? pred1.split(":")[1] : pred1;
    return Utils.predModules[pred] ? Utils.predModules[pred] : [];
  }
  // get all the builtin predicates names from the loaded snippet
  public static getBuiltinNames(): string[] {
    let builtins: string[] = Object.getOwnPropertyNames(Utils.snippets);
    builtins = builtins.filter(name => {
      return !/:/.test(name) && /\//.test(name);
    });
    builtins = builtins.map(name => {
      return name.match(/(.+)\//)[1];
    });
    builtins = builtins.filter((item, index, original) => {
      return !/\W/.test(item) && original.indexOf(item) == index;
    });
    return builtins;
  }

  // get the predicate under the cursor
  public static getPredicateUnderCursor(
    doc: TextDocument,
    position: Position
  ): IPredicate {
    // get predicate name range
    let wordRange: Range = doc.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }
    // get predicate name
    let predName: string = doc.getText(wordRange);
    let re = new RegExp("^" + predName + "\\s*\\(");
    let re1 = new RegExp("^" + predName + "\\s*\\/\\s*(\\d+)");
    let wholePred: string;
    let arity: number;
    let params: string;
    const docTxt = doc.getText(); // get the entire text of the prolog file
    let text = docTxt
      .split("\n")
      .slice(position.line)// get juste the line of the predicate
      .join("")
      .slice(wordRange.start.character)
      .replace(/\s+/g, " "); // replace all whitespaces by space

    let module = null;

    if (re.test(text)) {
      let i = text.indexOf("(") + 1;// get the position of the first parenthesis
      let matched = 1;
      // iteration if parenthesis in parenthesis
      while (matched > 0) { 
        if (text.charAt(i) === "(") {
          matched++;
          i++;
          continue;
        }
        if (text.charAt(i) === ")") {
          matched--;
          i++;
          continue;
        }
        i++;// index of the last parenthesis
      }
      wholePred = text.slice(0, i); // get the whole predicate
      arity = Utils.getPredicateArity(wholePred); // get the number of parameters
      params = wholePred.slice(predName.length);
      // find the module if a predicate is picked in :-module or :-use_module
    } else if (re1.test(text)) {
      arity = parseInt(text.match(re1)[1]);
      params =
        arity === 0 ? "" : "(" + new Array(arity).fill("_").join(",") + ")";
      wholePred = predName + params;
      switch (Utils.DIALECT) {
        case "swi":
          let reg = new RegExp(
            "module\\s*\\(\\s*([^,\\(]+)\\s*,\\s*\\[[^\\]]*?" +
            predName +
            "/" +
            arity +
            "\\b"
          );
          let mtch = docTxt.replace(/\n/g, "").match(reg);
          if (mtch) {
            let mFile = jsesc(mtch[1]);
            let mod = Utils.execPrologSync(
              ["-q"],
              `find_module :-
                absolute_file_name(${mFile}, File, [file_type(prolog)]),
                load_files(File),
                source_file_property(File, module(Mod)),
                writeln(module:Mod).`,
              "find_module",
              "true",
              /module:(\w+)/
            );
            if (mod) {
              module = mod[1];
            }
          }
          break;
        case "ecl":
          let modDefMatch = docTxt.match(/\n?\s*:-\s*module\((\w+)\)/);
          let expRe1 = new RegExp(
            "\\n\\s*:-\\s*export[^\\.]+\\b" + predName + "\\s*/\\s*" + arity
          );
          let expRe2 = new RegExp(
            "\\n\\s*:-\\s*import.*\\b" +
            predName +
            "\\s*/\\s*" +
            arity +
            "\\b.*from\\s*(\\w+)"
          );
          let impModMtch = docTxt.match(expRe2);
          if (modDefMatch && expRe1.test(docTxt)) {
            module = modDefMatch[1];
          } else if (impModMtch) {
            module = impModMtch[1];
          }
          break;
        default:
          break;
      }
    } else {
      arity = 0;
      params = "";
      wholePred = predName;
    }
    //get module doesnt work and useless
    /*
    const fileName = jsesc(window.activeTextEditor.document.fileName);
    if (!module) {
      let modMatch = docTxt
        .slice(0, doc.offsetAt(wordRange.start))
        .match(/([\S]+)\s*:\s*$/);
      if (modMatch) {
        module = modMatch[1];
      } else {
        let mod: string[];
        switch (Utils.DIALECT) {
          case "swi":
            const fm = path.resolve(`${__dirname}/findmodule.pl`);
            mod = Utils.execPrologSync(
              ["-q", fm],
              "",
              `(find_module('${fileName}',
              ${wholePred},
              Module),
              writeln(module:Module))`,
              "true",
              /module:(\w+)/
            );
            break;
          case "ecl":
            let modMtch = docTxt.match(/\n?\s*:-\s*module\((\w+)\)/);
            let currMod: string, clause: string;
            if (modMtch) {
              clause = `find_module :-
                  use_module('${fileName}'),
                  get_flag(${predName}/${arity}, definition_module, Module)@${
                modMtch[1]
                },
                  printf('module:%s%n', [Module])`;
            } else {
              clause = `find_module :-
                  ensure_loaded('${fileName}'),
                  get_flag(${predName}/${arity}, definition_module, Module),
                  printf('module:%s%n', [Module])`;
            }
            mod = Utils.execPrologSync(
              [],
              clause,
              "find_module",
              "true",
              /module:(\w+)/
            );
            break;
          default:
            break;
        }
        if (mod) {
          module = mod[1];
        } else {
          module = null;
        }
      }
    }*/

    return {
      wholePred: module ? module + ":" + wholePred : wholePred,
      pi: module
        ? module + ":" + predName + "/" + arity
        : predName + "/" + arity,
      functor: predName,
      arity: arity,
      params: params,
      module: module
    };
  }
  // get the number of parameters
  public static getPredicateArity(pred: string): number {
    let re = /^\w+\((.+)\)$/;
    if (!re.test(pred)) { // if predicate have parameters
      return 0;
    }
    let args = [],
      plCode: string;
    // get the Arity from prolog
    switch (Utils.DIALECT) {
      case "swi":
        args = ["-f", "none", "-q"];
        plCode = `
          outputArity :-
            read(Term),
            functor(Term, _, Arity),
            format("arity=~d~n", [Arity]).
        `;
        break;
      case "ecl":
        plCode = `
          outputArity :-
            read(Term),
            functor(Term, _, Arity),
            printf("arity=%d%n", [Arity]).
        `;

      default:
        break;
    }
    let result = Utils.execPrologSync( // execute a prolog query 
      args,
      plCode,
      "outputArity",
      pred,
      /arity=(\d+)/
    );
    return result ? parseInt(result[1]) : -1; // return the number of parameters
  }

  // execute a prolog query 
  public static execPrologSync(
    args: string[],
    clause: string,
    call: string, // goal to call
    inputTerm: string, // input
    resultReg: RegExp
  ): string[] {
    let plCode = jsesc(clause, { quotes: "double" }); // stringify 
    let input: string,
      prologProcess: cp.SpawnSyncReturns<string | Buffer>,
      runOptions: cp.SpawnSyncOptions;
    // execute the query by transforming it in a stream
    switch (Utils.DIALECT) {
      case "swi":
        input = `
          open_string("${plCode}", Stream), 
          load_files(runprolog, [stream(Stream)]).
          ${call}. 
          ${inputTerm}.
          halt.
        `;
        runOptions = {
          cwd: workspace.workspaceFolders[0].uri.fsPath, // rootpath of the project
          encoding: "utf8",
          input: input
        };
        prologProcess = cp.spawnSync(Utils.RUNTIMEPATH, args, runOptions); // create a subprocess with prolog (specified runtimepath)
        break;
      case "ecl":
        input = `${inputTerm}.`;
        args = args.concat([
          "-e",
          `open(string(\"${
          plCode
          }\n\"), read, S),compile(stream(S)),close(S),call(${call}).`
        ]);
        runOptions = {
          cwd: workspace.workspaceFolders[0].uri.fsPath,// rootpath of the project
          encoding: "utf8",
          input: input
        };
        prologProcess = cp.spawnSync(Utils.RUNTIMEPATH, args, runOptions);// create a subprocess with prolog (specified runtimepath)
        break;
      default:
        break;
    }
    // get the response in output
    if (prologProcess.status === 0) {
      let output = prologProcess.stdout.toString(); // get output with stdout
      let err = prologProcess.stderr.toString();
      // console.log("out:" + output);
      // console.log("err:" + err);

      let match = output.match(resultReg); // select the wanted result with the regex expression 
      return match ? match : null;
    } else {
      console.log("UtilsExecSyncError: " + prologProcess.stderr.toString());
      return null;
    }
  }
  //Update the builtin predicates in the SyntaxFile from the snipet file | Not use
  public static insertBuiltinsToSyntaxFile(context: ExtensionContext) {
    let syntaxFile = path.resolve(
      context.extensionPath + "/syntaxes/prolog.tmLanguage.yaml"
    );
    YAML.load(syntaxFile, obj => {
      let builtins: string = Utils.getBuiltinNames().join("|");
      obj.repository.builtin.patterns[1].match = "\\b(" + builtins + ")\\b";
      let newSnippets = YAML.stringify(obj, 5);
      fs.writeFile(syntaxFile, newSnippets, err => {
        return console.error(err);
      });
    });
  }
/* //OLD
  public static isValidEclTerm(docText: string, str: string): boolean {
    if (Utils.DIALECT !== "ecl") {
      return false;
    }
    let lm = path.resolve(
      `${Utils.CONTEXT.extensionPath}/out/src/features/load_modules`
    );
    let goals = `
        use_module('${lm}'),
        load_modules_from_text("${docText}"),
        catch((term_string(_, "${str}"), writeln("result:validTerm")),
          _, writeln("result:invalidTerm")).
          `;
    let runOptions: cp.SpawnSyncOptions;
    runOptions = {
      cwd: workspace.workspaceFolders[0].uri.fsPath,
      encoding: "utf8",
      input: goals
    };
    let prologProcess = cp.spawnSync(Utils.RUNTIMEPATH, [], runOptions);
    if (prologProcess.status === 0) {
      let output = prologProcess.stdout.toString();
      let err = prologProcess.stderr.toString();
      let match = output.match(/result:validTerm/);
      return match ? true : false;
    } else {
      return false;
    }
  }*/
}
