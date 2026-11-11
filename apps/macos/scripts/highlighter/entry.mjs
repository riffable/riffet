// Bundled into Riffet/Resources/highlight.js by build-highlighter.sh; run by JavaScriptCore.
import { refractor } from 'refractor/core';
import markup from 'refractor/markup';
import css from 'refractor/css';
import less from 'refractor/less';
import scss from 'refractor/scss';
import javascript from 'refractor/javascript';
import jsx from 'refractor/jsx';
import typescript from 'refractor/typescript';
import tsx from 'refractor/tsx';
import json from 'refractor/json';
import json5 from 'refractor/json5';
import yaml from 'refractor/yaml';
import toml from 'refractor/toml';
import ini from 'refractor/ini';
import bash from 'refractor/bash';
import powershell from 'refractor/powershell';
import sql from 'refractor/sql';
import markdown from 'refractor/markdown';
import python from 'refractor/python';
import go from 'refractor/go';
import rust from 'refractor/rust';
import java from 'refractor/java';
import kotlin from 'refractor/kotlin';
import swift from 'refractor/swift';
import c from 'refractor/c';
import cpp from 'refractor/cpp';
import csharp from 'refractor/csharp';
import ruby from 'refractor/ruby';
import php from 'refractor/php';
import dart from 'refractor/dart';
import scala from 'refractor/scala';
import lua from 'refractor/lua';
import r from 'refractor/r';
import perl from 'refractor/perl';
import objectivec from 'refractor/objectivec';
import elixir from 'refractor/elixir';
import erlang from 'refractor/erlang';
import haskell from 'refractor/haskell';
import clojure from 'refractor/clojure';
import graphql from 'refractor/graphql';
import protobuf from 'refractor/protobuf';
import docker from 'refractor/docker';
import makefile from 'refractor/makefile';
import nginx from 'refractor/nginx';
import apacheconf from 'refractor/apacheconf';
import diff from 'refractor/diff';
import regex from 'refractor/regex';
refractor.register(markup);
refractor.register(css);
refractor.register(less);
refractor.register(scss);
refractor.register(javascript);
refractor.register(jsx);
refractor.register(typescript);
refractor.register(tsx);
refractor.register(json);
refractor.register(json5);
refractor.register(yaml);
refractor.register(toml);
refractor.register(ini);
refractor.register(bash);
refractor.register(powershell);
refractor.register(sql);
refractor.register(markdown);
refractor.register(python);
refractor.register(go);
refractor.register(rust);
refractor.register(java);
refractor.register(kotlin);
refractor.register(swift);
refractor.register(c);
refractor.register(cpp);
refractor.register(csharp);
refractor.register(ruby);
refractor.register(php);
refractor.register(dart);
refractor.register(scala);
refractor.register(lua);
refractor.register(r);
refractor.register(perl);
refractor.register(objectivec);
refractor.register(elixir);
refractor.register(erlang);
refractor.register(haskell);
refractor.register(clojure);
refractor.register(graphql);
refractor.register(protobuf);
refractor.register(docker);
refractor.register(makefile);
refractor.register(nginx);
refractor.register(apacheconf);
refractor.register(diff);
refractor.register(regex);

function walk(nodes, classes, out) {
  for (const node of nodes) {
    if (node.type === 'text') out.push([node.value, classes]);
    else if (node.type === 'element') {
      const own = (node.properties && node.properties.className) || [];
      walk(node.children, own.length ? classes.concat(own.filter((name) => name !== 'token')) : classes, out);
    }
  }
}

// Flat [text, classes] runs, or null when the language is unknown.
globalThis.riffetHighlight = (code, language) => {
  if (!refractor.registered(language)) return null;
  const out = [];
  walk(refractor.highlight(code, language).children, [], out);
  return JSON.stringify(out);
};
