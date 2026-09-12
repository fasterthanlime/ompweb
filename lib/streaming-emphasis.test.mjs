import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import {streamingEmphasis} from './streaming-emphasis.ts';
const render = (text, streaming=true) => renderToStaticMarkup(React.createElement(ReactMarkdown,{remarkPlugins:streaming?[streamingEmphasis]:[]},text));
test('unfinished streaming emphasis renders without raw delimiters',()=>{
 assert.equal(render('**Not bold yet'),'<p><strong>Not bold yet</strong></p>');
 assert.equal(render('*Not italic yet'),'<p><em>Not italic yet</em></p>');
 assert.equal(render('**Now bold** yey'),render('**Now bold** yey',false));
 assert.equal(render('**Not bold yet',false),'<p>**Not bold yet</p>');
});
test('code, escapes, lists and completed paragraphs are not reinterpreted',()=>{
 for(const source of ['`**code`','```\n**code','\\*literal','* item','**old\n\nnew paragraph','a*b','***']) assert.equal(render(source),render(source,false));
});
