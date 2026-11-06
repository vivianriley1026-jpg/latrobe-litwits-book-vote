import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await readFile('public/index.html', 'utf8');
const script = await readFile('public/app.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('member form, private links, refresh preserves drafts, voting and organizer controls', async () => {
  const dom = new JSDOM(html, { url:'https://bookvote.test/', runScripts:'outside-only' });
  const { window } = dom;
  const q = selector => window.document.querySelector(selector);
  const calls = [];
  let poll = { id:'round', title:'Next read', phase:'nominations', durationHours:48, createdAt:new Date().toISOString(), closesAt:null, closed:false, isAdmin:true, participants:[], books:[], votes:{}, voteCount:0, results:null };
  window.confirm = () => true;
  window.fetch = async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({path,body});
    let extra = {};
    if (path === '/api/polls') extra = { sharePath:'/poll/round', adminPath:'/poll/round?admin=private-secret' };
    if (path.endsWith('/nominate')) {
      poll.participants = [{id:'me',name:body.name}, ...poll.participants.filter(p=>p.id!=='me')];
      poll.books = [{id:'mine',title:body.title,author:body.author,recommenderId:'me'}, ...poll.books.filter(b=>b.id!=='mine')];
      extra = {participantId:'me',editKey:'member-edit-secret'};
    }
    if (path.endsWith('/start')) {
      poll.phase='voting'; poll.votingStartedAt=new Date().toISOString(); poll.closesAt=new Date(Date.now()+48*3600000).toISOString();
    }
    if (path.endsWith('/vote')) { poll.votes[body.participantId]={bookId:body.bookId};poll.voteCount=1; }
    if (path.endsWith('/close')) { poll.closed=true;poll.results={votesByBook:{mine:1,other:0},winners:['mine']}; }
    return { ok:true, json:async()=>structuredClone({poll,...extra}) };
  };
  try {
    window.eval(script);
    assert.equal(q('#collectionMode').value,'nominations');
    assert.ok(q('#manualEntries').classList.contains('hidden'));
    q('#collectionMode').value='manual'; q('#collectionMode').dispatchEvent(new window.Event('change'));
    assert.ok(!q('#manualEntries').classList.contains('hidden'));
    assert.equal(window.document.querySelectorAll('.entry-row').length,2);
    q('#collectionMode').value='nominations';q('#collectionMode').dispatchEvent(new window.Event('change'));
    q('#createForm').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.equal(calls[0].body.mode,'nominations');
    assert.equal(q('#shareLink').value,'https://bookvote.test/poll/round');
    assert.equal(q('#organizerLink').value,'https://bookvote.test/poll/round?admin=private-secret');
    assert.ok(q('#startVoting').disabled);
    assert.equal(q('#timer').textContent,'Nominations open');
    q('#voterOnly').click();
    assert.ok(!q('#nomineeTitle').required);
    assert.equal(q('#nominationForm button').textContent,'Join the vote');
    q('#voterOnly').click();assert.ok(q('#nomineeAuthor').required);
    q('#nomineeName').value='Tim';q('#nomineeTitle').value='<img src=x onerror=alert(1)>';q('#nomineeAuthor').value='Author';
    q('#nominationForm').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.equal(calls.at(-1).body.name,'Tim');
    assert.equal(q('#nominationList img'),null); // User input is text, not executable markup.
    assert.equal(q('#nominationForm button').textContent,'Save changes');
    assert.equal(JSON.parse(window.localStorage.getItem('bookvote:round:nomination')).editKey,'member-edit-secret');
    assert.match(q('#voteMessage').textContent,/Saved/);
    q('#nomineeTitle').value='Unsaved new title';
    poll.participants.push({id:'other-person',name:'Sarah'},{id:'voter',name:'Just Voting'});
    poll.books.push({id:'other',title:'Another book',author:'Another author',recommenderId:'other-person'});
    await window.refreshPoll();
    assert.equal(q('#nomineeTitle').value,'Unsaved new title');
    assert.equal(q('#nominationCount').textContent,'2 books · 3 members joined');
    assert.ok(!q('#startVoting').disabled);
    q('#nominationForm').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.equal(calls.at(-1).body.editKey,'member-edit-secret');
    assert.equal(calls.at(-1).body.participantId,'me');
    q('#startVoting').click();await flush();
    assert.equal(q('#nominationForm'),null);
    assert.ok(q('[data-book-id="mine"]').disabled);
    assert.equal(q('#participantSelect').value,'me');
    assert.ok(q('#startVoting').classList.contains('hidden'));
    assert.ok(!q('#closeNow').classList.contains('hidden'));
    q('#participantSelect').value='voter';q('#participantSelect').dispatchEvent(new window.Event('change'));
    q('[data-book-id="mine"]').click();await flush();
    assert.equal(calls.at(-1).body.participantId,'voter');
    assert.equal(calls.at(-1).body.adminKey,'private-secret');
    assert.equal(q('#voteMessage').textContent,'Vote saved.');
    q('#closeNow').click();await flush();
    assert.equal(q('#pollState').textContent,'Final results');
    assert.ok(q('#closeNow').classList.contains('hidden'));
    assert.ok(q('.winner'));
  } finally { window.close(); }
});

test('member link hides organizer controls and shows actionable errors', async () => {
  const dom = new JSDOM(html, {url:'https://bookvote.test/poll/member-round',runScripts:'outside-only'});
  const {window}=dom;const q=s=>window.document.querySelector(s);
  const poll={id:'member-round',title:'Members',phase:'nominations',durationHours:24,closed:false,isAdmin:false,participants:[],books:[],votes:{},voteCount:0};
  window.fetch=async(path,options)=> options.method === 'POST' ? {ok:false,json:async()=>({error:'That name is already on the list.'})} : {ok:true,json:async()=>({poll})};
  try {
    window.eval(script);await flush();
    assert.ok(q('#organizerControls').classList.contains('hidden'));
    assert.equal(q('#organizerLink').value,'');
    q('#nomineeName').value='Alex';q('#nomineeTitle').value='Title';q('#nomineeAuthor').value='Author';
    q('#nominationForm').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.equal(q('#voteMessage').textContent,'That name is already on the list.');
    assert.equal(q('#nomineeTitle').value,'Title');
    assert.ok(!q('#nominationForm button').disabled);
  } finally { window.close(); }
});

test('organizer sees runoff and draw controls, members see history and the recorded winner', async () => {
  const dom=new JSDOM(html,{url:'https://bookvote.test/poll/tie?admin=organizer',runScripts:'outside-only'});
  const {window}=dom;const q=s=>window.document.querySelector(s);
  let poll={id:'tie',title:'Tie round',phase:'voting',roundNumber:1,allowSelfVote:false,durationHours:24,closed:true,isAdmin:true,createdAt:new Date().toISOString(),closesAt:new Date().toISOString(),participants:[{id:'a',name:'A'},{id:'b',name:'B'}],books:[{id:'alpha',title:'Alpha',author:'Author A',recommenderId:'a'},{id:'beta',title:'Beta',author:'Author B',recommenderId:'b'}],votes:{a:{bookId:'beta'},b:{bookId:'alpha'}},voteCount:2,results:{votesByBook:{alpha:1,beta:1},winners:['alpha','beta']}};
  window.confirm=()=>true;
  window.fetch=async(path,options)=>{
    if(path.endsWith('/runoff')) {
      poll.roundHistory=[{roundNumber:1,books:structuredClone(poll.books),voteCount:2,results:structuredClone(poll.results)}];
      poll.roundNumber=2;poll.allowSelfVote=true;poll.closed=false;poll.durationHours=5;poll.votes={};poll.voteCount=0;poll.results=null;poll.closesAt=new Date(Date.now()+5*3600000).toISOString();
    }
    if(path.endsWith('/close')) {poll.closed=true;poll.voteCount=2;poll.results={votesByBook:{alpha:1,beta:1},winners:['alpha','beta']};}
    if(path.endsWith('/draw')) poll.randomDraw={candidateIds:['alpha','beta'],winnerId:'beta',drawnAt:new Date().toISOString()};
    return {ok:true,json:async()=>structuredClone({poll})};
  };
  try {
    window.localStorage.setItem('bookvote:tie:participant','a');
    window.eval(script);await flush();
    assert.match(q('.result-notice').textContent,/2-way tie/);assert.ok(q('#startRunoff'));assert.equal(q('#drawWinner'),null);
    q('#startRunoff').click();await flush();
    assert.equal(window.location.pathname,'/poll/tie');
    assert.equal(q('#pollState').textContent,'Tiebreaker · Round 2');
    assert.ok(!q('[data-book-id="alpha"]').disabled);
    assert.match(q('.runoff-note').textContent,/including their own recommendation/);
    q('#closeNow').click();await flush();
    assert.equal(q('#startRunoff'),null);assert.ok(q('#drawWinner'));assert.match(q('.round-history').textContent,/First-round results/);
    q('#drawWinner').click();await flush();
    assert.equal(q('#drawWinner'),null);assert.match(q('.result-notice').textContent,/Tiebreaker resolved/);assert.equal(q('.winner .book-title').textContent,'Beta');
    assert.match(q('.result-notice').textContent,/vote totals below are unchanged/);
    poll.isAdmin=false;poll.randomDraw=null;
    await window.refreshPoll();
    assert.equal(q('#drawWinner'),null);assert.match(q('.result-notice').textContent,/organizer/);
  } finally {window.close();}
});
