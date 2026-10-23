const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Activity = require('../src/modules/activity/Activity');
const Group = require('../src/modules/groups/Group');
const Member = require('../src/modules/groups/GroupMember');
const Expense = require('../src/modules/expenses/Expense');
const { recordActivity, expenseSnapshot, changesBetween } = require('../src/modules/activity/activity.service');
const { getActivity } = require('../src/modules/activity/activity.controller');
const expenses = require('../src/modules/expenses/expense.controller');
const groups = require('../src/modules/groups/group.controller');
const { finishPayment } = require('../src/modules/bills/bill.payment');
const Bill = require('../src/modules/bills/Bill');
const a = '507f1f77bcf86cd799439011', b = '507f1f77bcf86cd799439012', e = '507f1f77bcf86cd799439013';
const response = () => ({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const query = value => ({sort(){return this;},skip(){return this;},limit(){return this;},populate(){return this;},lean(){return Promise.resolve(value);},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
afterEach(()=>mock.restoreAll());
function capture() {const events=[];mock.method(Activity,'updateOne',async(filter,update)=>{events.push({filter,event:update.$setOnInsert});});return events;}

test('expense snapshots retain deleted item assignments and normalize populated users without emails',()=>{
 const snapshot=expenseSnapshot({description:'Dinner',paidBy:{_id:a,email:'private'},participants:[{userId:{_id:b,email:'private'},amount:10,shares:2}],items:[{description:'Meal',quantity:1,amount:10,memberIds:[{_id:b}]}]},'KWD');
 assert.equal(snapshot.currency,'KWD');assert.equal(snapshot.paidBy,a);assert.equal(snapshot.participants[0].userId,b);assert.deepEqual(snapshot.items[0].memberIds,[b]);assert.ok(!JSON.stringify(snapshot).includes('private'));
 assert.deepEqual(changesBetween({name:'Trip',icon:'people'},{name:'Holiday',icon:'people'}),{name:{before:'Trip',after:'Holiday'}});
});
test('stable event identity prevents duplicated payment history independently of optional indexes',async()=>{
 const events=capture();const event={groupId:a,actor:b,action:'BILL_PAID',targetId:e,label:'Rent',eventKey:`bill-paid:${e}`};
 assert.equal(await recordActivity(event),true);assert.equal(await recordActivity(event),true);
 assert.equal(events[0].filter._id,events[1].filter._id);assert.deepEqual(events[0].event,event);
 mock.method(Activity,'updateOne',async()=>{const error=new Error('duplicate');error.code=11000;throw error;});assert.equal(await recordActivity(event),true);
});
test('history storage failures do not report a completed financial mutation as failed',async()=>{
 mock.method(Activity,'updateOne',async()=>{throw Error('offline');});mock.method(console,'error',()=>{});
 assert.equal(await recordActivity({}),false);
});
test('activity listing scopes count and results, limits actor fields, orders ties and strips internal metadata',async()=>{
 const chain=query([{_id:e,actor:{_id:b,firstName:'Sam'},action:'EXPENSE_DELETED',label:'Meal',targetId:e,eventKey:'private',groupId:a,occurredAt:new Date()}]);
 mock.method(Activity,'find',filter=>{assert.deepEqual(filter,{groupId:a});return chain;});
 chain.sort=sort=>{assert.deepEqual(sort,{occurredAt:-1,_id:-1});return chain;};chain.skip=n=>{assert.equal(n,20);return chain;};chain.limit=n=>{assert.equal(n,20);return chain;};chain.populate=(field,select)=>{assert.equal(field,'actor');assert.equal(select,'firstName lastName');return chain;};
 mock.method(Activity,'countDocuments',async filter=>{assert.deepEqual(filter,{groupId:a});return 21;});
 const res=response();await getActivity({params:{id:a},query:{page:'2'}},res);
 assert.equal(res.body.data.pagination.totalPages,2);assert.equal(res.body.data.activities[0].eventKey,undefined);assert.equal(res.body.data.activities[0].groupId,undefined);
});
test('invalid and repeated pagination is rejected before querying storage',async()=>{
 mock.method(Activity,'find',()=>assert.fail('invalid pagination must not query'));
 for(const query of [{page:'0'},{page:['1','2']},{page:'1000001'},{limit:'101'},{limit:{}},{limit:'1.5'}]) {const res=response();await getActivity({query,params:{id:a}},res);assert.equal(res.statusCode,400);}
});
test('expense deletion preserves actor, amount, native currency and description; forbidden calls create no history',async()=>{
 const events=capture();const expense={_id:e,groupId:a,description:'Dinner',amount:123,paidBy:b,participants:[{userId:a,amount:123}],splitType:'EQUAL'};
 mock.method(Expense,'findById',async()=>expense);mock.method(Member,'findOne',async()=>({}));mock.method(Expense,'findByIdAndDelete',async()=>expense);
 const req={params:{expenseId:e},user:{_id:b},group:{currency:'JPY'}};const res=response();await expenses.deleteExpense(req,res);assert.equal(res.statusCode,200);
 assert.equal(events.length,1);assert.equal(events[0].event.action,'EXPENSE_DELETED');assert.equal(events[0].event.actor,b);assert.equal(events[0].event.snapshot.currency,'JPY');assert.equal(events[0].event.snapshot.description,'Dinner');
 mock.method(Member,'findOne',async()=>null);const denied=response();await expenses.deleteExpense(req,denied);assert.equal(denied.statusCode,403);assert.equal(events.length,1);
});
test('group updates record changed fields only and suppress no-op and failed settings changes',async()=>{
 const events=capture();const group={_id:a,ownerId:b,name:'Trip',currency:'PHP',icon:'people',async save(){}};
 mock.method(Group,'findById',async()=>group);
 const req={params:{id:a},user:{_id:b},body:{name:'Holiday'}};let res=response();await groups.updateGroup(req,res);assert.equal(res.statusCode,200);
 assert.deepEqual(events[0].event.changes,{name:{before:'Trip',after:'Holiday'}});
 res=response();await groups.updateGroup(req,res);assert.equal(events.length,1);
 req.body={icon:'fake-icon'};res=response();await groups.updateGroup(req,res);assert.equal(res.statusCode,400);assert.equal(events.length,1);
});
test('bill payment retries retain the original recorder and produce a single stable event identity',async()=>{
 const events=capture();const bill={_id:e,groupId:a,expenseId:b,payment:{recordedBy:a,description:'Power',amount:100,currency:'PHP',paidBy:b,paidAt:new Date(),splitType:'EQUAL',participants:[{userId:a,amount:100}]}};
 mock.method(Expense,'findOneAndUpdate',async()=>({_id:b}));mock.method(Bill,'findOneAndUpdate',async()=>({...bill,status:'PAID'}));
 await finishPayment(bill);await finishPayment(bill);
 assert.equal(events.length,2);assert.equal(events[0].filter._id,events[1].filter._id);assert.equal(events[0].event.actor,a);assert.equal(events[0].event.snapshot.paidBy,b);
});
test('activity endpoint enforces authentication, active membership and hidden-group access',async()=>{
 const jwt=require('jsonwebtoken');const User=require('../src/modules/users/User');const RevokedToken=require('../src/modules/auth/RevokedToken');
 process.env.JWT_SECRET='activity-tests-only';
 mock.method(User,'findById',()=>({select:async()=>({_id:b})}));mock.method(RevokedToken,'exists',async()=>false);
 mock.method(Group,'findById',async()=>({_id:a}));mock.method(Member,'findOne',async()=>({role:'MEMBER'}));
 mock.method(Activity,'find',()=>query([]));mock.method(Activity,'countDocuments',async()=>0);
 const server=require('../src/app').listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const url=`http://127.0.0.1:${server.address().port}/api/groups/${a}/activity`;
 const headers={Authorization:`Bearer ${jwt.sign({userId:b},process.env.JWT_SECRET)}`};
 try {
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers})).status,200);
  mock.method(Member,'findOne',async()=>null);assert.equal((await fetch(url,{headers})).status,403);
  mock.method(Group,'findById',async()=>({_id:a,deletedAt:new Date()}));assert.equal((await fetch(url,{headers})).status,404);
 } finally {await new Promise(resolve=>server.close(resolve));}
});

test('expense add and edit use the authenticated recorder and store real before/after amounts',async()=>{
 const events=capture();let expense;
 mock.method(Member,'findOne',async()=>({}));mock.method(Member,'find',async()=>[{userId:b}]);mock.method(Group,'findById',async()=>({currency:'PHP'}));
 mock.method(Expense,'create',async fields=>{expense=new Expense({_id:e,...fields});expense.populate=async()=>{};expense.save=async()=>{};return expense;});
 mock.method(Expense,'findById',async()=>expense);
 const req={params:{id:a,expenseId:e},user:{_id:a},group:{currency:'PHP'},body:{description:'Meal',amount:10,paidBy:b,splitType:'EQUAL',participants:[{userId:b}],date:'2026-10-24'}};
 let res=response();await expenses.createExpense(req,res);assert.equal(res.statusCode,201);assert.equal(events[0].event.actor,a);assert.equal(events[0].event.snapshot.paidBy,b);
 req.body={amount:20};res=response();await expenses.updateExpense(req,res);assert.equal(res.statusCode,200);assert.equal(events[1].event.action,'EXPENSE_EDITED');assert.deepEqual(events[1].event.changes.amount,{before:10,after:20});assert.equal(events[1].event.changes.description,undefined);
});

test('a losing concurrent expense deletion does not attribute the removal to a second recorder',async()=>{
 const events=capture();mock.method(Expense,'findById',async()=>({_id:e,groupId:a,description:'Meal'}));mock.method(Member,'findOne',async()=>({}));mock.method(Expense,'findByIdAndDelete',async()=>null);
 const res=response();await expenses.deleteExpense({params:{expenseId:e},user:{_id:b}},res);assert.equal(res.statusCode,404);assert.equal(events.length,0);
});
