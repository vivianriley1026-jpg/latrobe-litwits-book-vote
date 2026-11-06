import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

async function start(dataDir) {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 8000);
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  return { child, url };
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

test('shared nominations, permissions, concurrency, clock, voting, persistence and legacy ballots', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookvote-test-'));
  const legacy = {
    id: 'legacy', adminKey: 'legacy-secret', title: 'Existing round', createdAt: new Date().toISOString(),
    closesAt: new Date(Date.now() + 3600000).toISOString(), closedAt: null,
    participants: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Chris' }],
    books: [{ id: 'x', title: 'Book X', author: 'X', recommenderId: 'a' }, { id: 'y', title: 'Book Y', author: 'Y', recommenderId: 'b' }], votes: {}
  };
  await writeFile(join(dataDir, 'polls.json'), JSON.stringify({ polls: { legacy } }));
  let server = await start(dataDir);
  let url = server.url;
  async function request(path, body, expected = 200) {
    const response = await fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, expected, JSON.stringify(json));
    return json;
  }
  try {
    // A missing phase on a pre-existing ballot means voting, not a migration/reset.
    assert.equal((await request('/api/polls/legacy')).poll.phase, 'voting');
    await request('/api/polls/legacy/vote', { participantId: 'c', bookId: 'x' });
    await request('/api/polls/legacy/vote', { participantId: 'a', bookId: 'x' }, 403);
    assert.equal((await request('/api/polls/legacy')).poll.voteCount, 1);
    const manual = await request('/api/polls', { hours: 5, entries: [{name:'A',title:'A'}, {name:'B',title:'B'}, {name:'C'}] }, 201);
    assert.equal(manual.poll.participants.length, 3);
    assert.equal(manual.poll.books.length, 2);
    assert.equal(manual.poll.phase, 'voting');
    await request('/api/polls', { entries: [{name:'A'}] }, 400);

    const created = await request('/api/polls', { mode: 'nominations', title: 'Next read', hours: 5 }, 201);
    const id = created.poll.id;
    const base = `/api/polls/${id}`;
    const adminKey = new URL(created.adminPath, url).searchParams.get('admin');
    assert.equal(created.poll.phase, 'nominations');
    assert.equal(created.poll.closesAt, null);
    assert.equal(created.poll.closed, false);
    assert.equal(created.poll.participants.length, 0);
    assert.ok(!created.sharePath.includes(adminKey));
    await request(base + '/start', {}, 403);
    await request(base + '/start', { adminKey }, 400);
    await request(base + '/close', { adminKey }, 400);
    await request(base + '/vote', {}, 403);
    await request(base + '/nominate', {name:'Incomplete',title:'Book'}, 400);
    const alex = await request(base + '/nominate', {name:'Alex',title:'First',author:'Writer'});
    assert.ok(alex.editKey);
    await request(base + '/nominate', {name:' alex ',title:'Other',author:'Writer'}, 409);
    await request(base + '/nominate', {participantId:alex.participantId,name:'Alex',title:'Hijack',author:'Writer'},403);
    await request(base + '/nominate', {participantId:alex.participantId,editKey:'bad',name:'Alex',title:'Hijack',author:'Writer'},403);
    const edit = await request(base + '/nominate', {participantId:alex.participantId,editKey:alex.editKey,name:'Alex',title:'Revised',author:'New author'});
    assert.equal(edit.poll.books.length, 1);
    assert.equal(edit.poll.books[0].title, 'Revised');
    assert.equal(edit.poll.isAdmin, false);
    assert.ok(!JSON.stringify(edit.poll).includes(alex.editKey));
    assert.ok(!JSON.stringify(edit.poll).includes(adminKey));
    const viewer = await request(base + '/nominate', {name:'Just Voting',voterOnly:true});
    assert.equal(viewer.poll.participants.length, 2);
    assert.equal(viewer.poll.books.length, 1);
    const concurrent = await Promise.all(Array.from({length:12}, (_, i) => request(base + '/nominate', {name:`Member ${i}`, title:`Book ${i}`, author:`Author ${i}`})));
    assert.equal(concurrent.length, 12);
    let poll = (await request(base)).poll;
    assert.equal(poll.participants.length, 14);
    assert.equal(poll.books.length, 13);
    assert.equal(poll.closesAt, null);
    // Concurrent duplicate names yield one success, not two registrations or an overwrite.
    const duplicates = await Promise.all([1,2].map(() => fetch(url + base + '/nominate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Same',title:'Title',author:'Author'})})));
    assert.deepEqual(duplicates.map(r=>r.status).sort(), [200,409]);
    const beforeStart = Date.now();
    const started = await request(base + '/start', {adminKey});
    assert.ok(Date.parse(started.poll.votingStartedAt) >= beforeStart);
    assert.equal(Date.parse(started.poll.closesAt) - Date.parse(started.poll.votingStartedAt), 5*3600000);
    assert.equal(started.poll.isAdmin, true);
    await request(base + '/start', {adminKey},409);
    await request(base + '/nominate', {name:'Too Late',title:'Title',author:'Author'},403);
    await request(base + '/nominate', {participantId:alex.participantId,editKey:alex.editKey,name:'Alex',title:'Late Edit',author:'Author'},403);
    const own = started.poll.books.find(b => b.recommenderId === alex.participantId);
    const other = started.poll.books.find(b => b.recommenderId !== alex.participantId);
    await request(base + '/vote', {participantId:alex.participantId,bookId:own.id},403);
    await request(base + '/vote', {participantId:alex.participantId,bookId:other.id});
    await request(base + '/vote', {participantId:viewer.participantId,bookId:own.id});
    await request(base + '/close', {adminKey:'wrong'},403);
    const closed = await request(base + '/close', {adminKey});
    assert.equal(closed.poll.closed,true);
    assert.equal(closed.poll.voteCount,2);
    await request(base + '/vote', {participantId:viewer.participantId,bookId:other.id},403);
    const persisted = JSON.parse(await readFile(join(dataDir,'polls.json'),'utf8'));
    assert.equal(persisted.polls.legacy.votes.c.bookId,'x');
    assert.equal(persisted.polls[id].participants.length,15);
    await stop(server.child);
    server = await start(dataDir); url = server.url;
    assert.equal((await request(base)).poll.voteCount,2);
    assert.equal((await request('/api/polls/legacy')).poll.voteCount,1);
    assert.equal((await request(base)).poll.closed,true);
    const invalid = await fetch(url + '/api/polls', {method:'POST',body:'{bad'});
    assert.equal(invalid.status,400);
    assert.equal((await request('/api/polls/legacy')).poll.title,'Existing round');
  } finally { await stop(server.child); await rm(dataDir,{recursive:true,force:true}); }
});

test('runoff keeps the same link and history; second tie resolves once without rerolls', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'bookvote-runoff-'));
  let server=await start(dataDir);let url=server.url;
  async function request(path, body, expected=200) {
    const r=await fetch(url+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
  }
  try {
    const initial=await request('/api/polls',{hours:24,entries:[{name:'A',title:'Alpha'},{name:'B',title:'Beta'},{name:'C',title:'Gamma'},{name:'D'}]},201);
    const base=`/api/polls/${initial.poll.id}`;const adminKey=new URL(initial.adminPath,url).searchParams.get('admin');
    const [a,b,c,d]=initial.poll.participants;const [alpha,beta]=initial.poll.books;
    await request(base+'/runoff',{adminKey},409);
    for (const [person,book] of [[a,beta],[b,alpha],[c,alpha],[d,beta]]) await request(base+'/vote',{participantId:person.id,bookId:book.id});
    await request(base+'/close',{adminKey});
    await request(base+'/draw',{adminKey},409);
    await request(base+'/runoff',{adminKey:'bad'},403);
    const runs=await Promise.all([1,2].map(()=>fetch(url+base+'/runoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminKey})})));
    assert.deepEqual(runs.map(r=>r.status).sort(),[200,409]);
    let poll=(await request(base)).poll;
    assert.equal(poll.id,initial.poll.id);assert.equal(poll.roundNumber,2);assert.equal(poll.allowSelfVote,true);
    assert.equal(poll.books.length,2);assert.equal(poll.participants.length,4);assert.equal(poll.voteCount,0);
    assert.equal(poll.durationHours,5);assert.equal(Date.parse(poll.closesAt)-Date.parse(poll.votingStartedAt),5*3600000);
    assert.equal(poll.roundHistory[0].books.length,3);assert.equal(poll.roundHistory[0].voteCount,4);
    assert.equal(poll.roundHistory[0].results.votesByBook[alpha.id],2);
    assert.equal(poll.roundHistory[0].votes,undefined); // Summary is public; original individual votes remain stored.
    await request(base+'/draw',{adminKey},409);
    await request(base+'/nominate',{name:'Late',title:'No',author:'No'},403);
    await request(base+'/vote',{participantId:a.id,bookId:alpha.id}); // Own finalist now allowed.
    await request(base+'/vote',{participantId:b.id,bookId:beta.id});
    await request(base+'/close',{adminKey});
    await request(base+'/runoff',{adminKey},409);
    await request(base+'/draw',{adminKey:'bad'},403);
    const draws=await Promise.all([request(base+'/draw',{adminKey}),request(base+'/draw',{adminKey})]);
    assert.deepEqual(draws[0].poll.randomDraw,draws[1].poll.randomDraw);
    const draw=draws[0].poll.randomDraw;
    assert.ok([alpha.id,beta.id].includes(draw.winnerId));assert.deepEqual(draw.candidateIds,[alpha.id,beta.id]);
    assert.equal(draws[0].poll.results.votesByBook[alpha.id],1);assert.equal(draws[0].poll.results.votesByBook[beta.id],1);
    const store=JSON.parse(await readFile(join(dataDir,'polls.json'),'utf8'));
    assert.equal(Object.keys(store.polls[initial.poll.id].roundHistory[0].votes).length,4);
    await stop(server.child);server=await start(dataDir);url=server.url;
    assert.deepEqual((await request(base)).poll.randomDraw,draw);
    assert.deepEqual((await request(base+'/draw',{adminKey})).poll.randomDraw,draw);
    const zero=await request('/api/polls',{entries:[{name:'A',title:'A'},{name:'B',title:'B'}]},201);
    const key=new URL(zero.adminPath,url).searchParams.get('admin');
    await request(`/api/polls/${zero.poll.id}/close`,{adminKey:key});
    await request(`/api/polls/${zero.poll.id}/runoff`,{adminKey:key},409);
    const single=await request('/api/polls',{entries:[{name:'A',title:'A'},{name:'B',title:'B'}]},201);
    const singleKey=new URL(single.adminPath,url).searchParams.get('admin');const singleBase=`/api/polls/${single.poll.id}`;
    await request(singleBase+'/vote',{participantId:single.poll.participants[0].id,bookId:single.poll.books[1].id});
    await request(singleBase+'/close',{adminKey:singleKey});
    await request(singleBase+'/runoff',{adminKey:singleKey},409);
  } finally { await stop(server.child);await rm(dataDir,{recursive:true,force:true}); }
});
