const {test,afterEach,mock}=require('node:test');
const assert=require('node:assert/strict');
const Expense=require('../src/modules/expenses/Expense');
const Member=require('../src/modules/groups/GroupMember');
const Group=require('../src/modules/groups/Group');
const R=require('../src/modules/expenses/expense.recurrence');
const controller=require('../src/modules/expenses/expense.controller');
const a='507f1f77bcf86cd799439011', b='507f1f77bcf86cd799439012', sourceId='507f1f77bcf86cd799439013';
afterEach(()=>mock.restoreAll());
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const request=body=>({params:{expenseId:sourceId,id:a},user:{_id:a},group:{currency:'PHP'},body});
const get=(doc,path)=>path.split('.').reduce((value,key)=>value?.[key],doc);
function matches(doc,filter){return Object.entries(filter).every(([key,value])=>{
 if(key==='$or')return value.some(part=>matches(doc,part));
 const actual=get(doc,key);
 if(value&&typeof value==='object'&&!(value instanceof Date)&&!value._bsontype){
  return Object.entries(value).every(([op,target])=>op==='$exists'?(actual!==undefined)===target:op==='$lte'?actual!=null&&new Date(actual)<=new Date(target):op==='$gt'?actual!=null&&new Date(actual)>new Date(target):op==='$ne'?actual!=null:actual===target);
 }
 return value==null?actual==null:String(actual)===String(value);
});}
function apply(doc,update){for(const [key,value] of Object.entries(update.$set||{})){const path=key.split('.');let parent=doc;for(const segment of path.slice(0,-1))parent=parent[segment];parent[path.at(-1)]=value;}for(const key of Object.keys(update.$unset||{})){const path=key.split('.');let parent=doc;for(const segment of path.slice(0,-1))parent=parent[segment];delete parent[path.at(-1)];}}
const query=value=>({select(){return Promise.resolve(value);},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
function fixture(overrides={}) {
 const source={_id:sourceId,groupId:a,description:'Shared plan',amount:10,category:'SUBSCRIPTIONS',paidBy:a,splitType:'SHARES',participants:[{userId:a,shares:2,amount:6.67,percentage:null},{userId:b,shares:1,amount:3.33,percentage:null}],date:new Date('2026-01-31T00:00:00Z'),notes:'Original',recurrenceSourceId:null,recurring:R.createSchedule({frequency:'MONTHLY'},'2026-01-31'),...overrides};
 source.toObject=()=>JSON.parse(JSON.stringify(source));source.populate=async()=>{};
 const generated=new Map();const errors=[];
 mock.method(Expense,'find',filter=>({cursor:async function*(){if(matches(source,filter))yield source;}}));
 mock.method(Expense,'findOneAndUpdate',(filter,update)=>{if(!matches(source,filter))return query(null);apply(source,update);return query(source);});
 mock.method(Expense,'findById',async id=>String(id)===sourceId?source:null);
 mock.method(Expense,'exists',async filter=>filter._id?matches(source,filter):generated.has(filter.occurrenceNumber));
 mock.method(Expense,'updateOne',async(filter,update,options)=>{
  if(update.$setOnInsert){assert.equal(options.upsert,true);assert.equal(options.runValidators,true);if(!generated.has(filter.occurrenceNumber))generated.set(filter.occurrenceNumber,update.$setOnInsert);return {modifiedCount:1};}
  if(matches(source,filter)){apply(source,update);return {modifiedCount:1};}return {modifiedCount:0};
 });
 mock.method(Group,'findById',async()=>({currency:'PHP'}));
 mock.method(Member,'find',async()=>[{userId:a},{userId:b}]);
 mock.method(Member,'findOne',async()=>({}));
 return {source,generated,errors,run:options=>R.generateRecurringExpenses({onError:(...args)=>errors.push(args),...options})};
}
test('schedule validation, UTC weekly/monthly/yearly anchors and inclusive end dates',()=>{
 for(const frequency of ['WEEKLY','MONTHLY','YEARLY'])assert.equal(R.createSchedule({frequency},'2026-01-31').frequency,frequency);
 assert.equal(R.occurrenceDate('2026-01-31','MONTHLY',1).toISOString().slice(0,10),'2026-02-28');
 assert.equal(R.occurrenceDate('2026-01-31','MONTHLY',2).toISOString().slice(0,10),'2026-03-31');
 assert.equal(R.occurrenceDate('2024-02-29','YEARLY',4).toISOString().slice(0,10),'2028-02-29');
 assert.equal(R.occurrenceDate('2026-01-31','WEEKLY',1).toISOString().slice(0,10),'2026-02-07');
 assert.equal(R.createSchedule({frequency:'MONTHLY',endDate:'2026-02-28'},'2026-01-31T12:00:00Z').nextDate.toISOString(),'2026-02-28T12:00:00.000Z');
 assert.equal(R.createSchedule({frequency:'MONTHLY',endDate:'2026-01-31'},'2026-01-31').nextDate,null);
 for(const value of [{frequency:'DAILY'},{frequency:'MONTHLY',endDate:'2026-02-30'},{frequency:'MONTHLY',endDate:'2025-12-31'},[],false,{frequency:'MONTHLY',paused:true}])assert.throws(()=>R.createSchedule(value,'2026-01-31'));
 assert.equal(R.createSchedule(undefined,'bad'),undefined);
});
test('only due occurrences are generated; payer, weighted split and metadata are reused',async()=>{
 const f=fixture();
 await f.run({now:new Date('2026-02-27')});assert.equal(f.generated.size,0);
 await f.run({now:new Date('2026-02-28')});assert.equal(f.generated.size,1);
 const child=f.generated.get(1);
 assert.equal(child.date.toISOString(),'2026-02-28T00:00:00.000Z');assert.equal(child.paidBy,a);assert.equal(child.recurring,undefined);
 assert.deepEqual(child.participants,f.source.participants);assert.equal(child.category,'SUBSCRIPTIONS');assert.equal(child.recurrenceSourceId,sourceId);
 assert.equal(f.source.recurring.nextDate.toISOString(),'2026-03-31T00:00:00.000Z');
 await f.run({now:new Date('2026-02-28')});assert.equal(f.generated.size,1);assert.equal(f.errors.length,0);
});
test('itemized lines, assignments, tax and tip copy exactly once into generated expenses',async()=>{
 const extras={tax:{amount:2,allocation:'PROPORTIONAL'},tip:{amount:1,allocation:'EQUAL'}};
 const f=fixture({splitType:'ITEMIZED',amount:13,participants:[{userId:a,amount:7.7},{userId:b,amount:5.3}],items:[{description:'Item',quantity:1,amount:10,memberIds:[a,b]}],adjustments:extras});
 await f.run({now:new Date('2026-02-28')});
 assert.deepEqual(f.generated.get(1).items,f.source.items);assert.deepEqual(f.generated.get(1).adjustments,extras);assert.equal(f.generated.get(1).amount,13);
});
test('bounded downtime catch-up stops at inclusive end date and preserves deleted history',async()=>{
 const f=fixture();f.source.recurring.endDate=R.endDate('2026-04-30');
 await f.run({now:new Date('2026-06-01'),maxPerSource:2});assert.equal(f.generated.size,2);
 await f.run({now:new Date('2026-06-01')});assert.equal(f.generated.size,3);assert.equal(f.source.recurring.nextDate,null);
 f.generated.delete(1);await f.run({now:new Date('2026-06-01')});assert.equal(f.generated.size,2);
});
test('overlapping workers and retry after checkpoint failure cannot duplicate an occurrence',async()=>{
 const f=fixture();
 const write=Expense.updateOne;
 let fail=true;
 mock.method(Expense,'updateOne',async(filter,update,options)=>{if(update.$set?.['recurring.nextNumber']&&fail){fail=false;throw Error('checkpoint interrupted');}return write(filter,update,options);});
 await f.run({now:new Date('2026-02-28')});assert.equal(f.generated.size,1);assert.equal(f.source.recurring.nextNumber,1);
 await Promise.all([f.run({now:new Date('2026-02-28')}),f.run({now:new Date('2026-02-28')})]);
 assert.equal(f.generated.size,1);assert.equal(f.source.recurring.nextNumber,2);
});
test('paused sources never generate and inactive member or deleted group auto-pauses',async()=>{
 const f=fixture();f.source.recurring.paused=true;
 await f.run({now:new Date('2026-04-01')});assert.equal(f.generated.size,0);
 f.source.recurring.paused=false;mock.method(Member,'find',async()=>[{userId:a}]);
 await f.run({now:new Date('2026-04-01')});assert.equal(f.generated.size,0);assert.equal(f.source.recurring.paused,true);assert.ok(f.source.recurring.lastError);
 f.source.recurring.paused=false;mock.method(Group,'findById',async()=>null);
 await f.run({now:new Date('2026-04-01')});assert.equal(f.generated.size,0);assert.equal(f.source.recurring.paused,true);
});
test('resume chooses a future anchor occurrence, skipping paused dates',async()=>{
 const f=fixture();f.source.recurring.paused=true;
 const res=response();await R.updateRecurrence(request({paused:false}),res);
 assert.equal(res.statusCode,200);assert.equal(f.source.recurring.paused,false);
 assert.ok(f.source.recurring.nextDate>new Date());assert.ok(f.source.recurring.nextNumber>1);
 assert.equal(R.nextAfter('2026-01-31','MONTHLY',new Date('2026-02-28'),1),2);
 assert.equal(R.nextAfter('2024-02-29','YEARLY',new Date('2025-03-01'),1),2);
});
test('schedule management checks membership, input, lease and concurrent worker progress',async()=>{
 const f=fixture();
 mock.method(Member,'findOne',async()=>null);
 let res=response();await R.updateRecurrence(request({paused:true}),res);assert.equal(res.statusCode,403);
 mock.method(Member,'findOne',async()=>({}));
 for(const body of [{paused:'yes'},{},{frequency:'WEEKLY'},{endDate:'2026-02-30'},{endDate:'2025-01-01'}]){res=response();await R.updateRecurrence(request(body),res);assert.equal(res.statusCode,400);}
 f.source.recurring.lockedUntil=new Date(Date.now()+60000);
 res=response();await R.updateRecurrence(request({paused:true}),res);assert.equal(res.statusCode,409);
 delete f.source.recurring.lockedUntil;
 res=response();await R.updateRecurrence(request({endDate:'2026-02-28',paused:true}),res);assert.equal(res.statusCode,200);assert.equal(f.source.recurring.paused,true);
 res=response();await R.updateRecurrence(request({endDate:null}),res);assert.equal(res.statusCode,200);assert.equal(f.source.recurring.endDate,null);
});
test('creating an expense validates schedule before write and first expense stays the source',async()=>{
 fixture();let saved;
 mock.method(Expense,'create',async fields=>{saved=fields;return {...fields,populate:async()=>{}};});
 const base={description:'Plan',amount:10,paidBy:a,splitType:'EQUAL',participants:[{userId:a},{userId:b}],date:'2026-01-31'};
 let res=response();await controller.createExpense(request({...base,recurring:{frequency:'MONTHLY',endDate:'2026-04-30'}}),res);
 assert.equal(res.statusCode,201);assert.equal(saved.recurring.nextNumber,1);assert.equal(saved.recurring.frequency,'MONTHLY');assert.equal(saved.date,'2026-01-31');
 saved=null;res=response();await controller.createExpense(request({...base,recurring:{frequency:'DAILY'}}),res);assert.equal(res.statusCode,400);assert.equal(saved,null);
});
test('schema enforces the unique occurrence index and old expenses have no schedule',()=>{
 const indexes=Expense.schema.indexes();assert.ok(indexes.some(([keys,options])=>keys.recurrenceSourceId===1&&keys.occurrenceNumber===1&&options.unique&&options.partialFilterExpression));
 assert.equal(new Expense().recurring,undefined);
 const doc=new Expense({groupId:a,description:'Plan',amount:10,paidBy:a,participants:[{userId:a,amount:10}],recurring:R.createSchedule({frequency:'WEEKLY'},'2026-01-31')});
 assert.equal(doc.validateSync(),undefined);assert.equal(doc.toObject().recurring.frequency,'WEEKLY');
});
test('worker refuses to start if unique indexes cannot be installed',async()=>{
 mock.method(Expense,'createIndexes',async()=>{throw Error('index failed');});
 await assert.rejects(R.startRecurringExpenseWorker(),/index failed/);
});

test('source edits change future templates without rewriting generated history or schedule anchor',async()=>{
 const f=fixture();
 await f.run({now:new Date('2026-02-28')});
 const old=JSON.stringify(f.generated.get(1));
 let res=response();await controller.updateExpense(request({amount:12,splitType:'EQUAL',participants:[{userId:a},{userId:b}]}),res);
 assert.equal(res.statusCode,200);assert.equal(f.source.amount,12);assert.equal(f.source.recurring.nextNumber,2);
 await f.run({now:new Date('2026-03-31')});assert.equal(f.generated.get(2).amount,12);assert.equal(JSON.stringify(f.generated.get(1)),old);
 res=response();await controller.updateExpense(request({date:'2026-02-01'}),res);assert.equal(res.statusCode,400);
 f.source.recurring.lockedUntil=new Date(Date.now()+60000);
 res=response();await controller.updateExpense(request({notes:'race'}),res);assert.equal(res.statusCode,409);
});
test('deletion of a source respects worker lease; uncheckpointed generated entries cannot be deleted',async()=>{
 const f=fixture();let deleted=false;
 mock.method(Expense,'findOneAndDelete',async filter=>{if(matches(f.source,filter)){deleted=true;return f.source;}return null;});
 f.source.recurring.lockedUntil=new Date(Date.now()+60000);
 let res=response();await controller.deleteExpense(request({}),res);assert.equal(res.statusCode,409);assert.equal(deleted,false);
 delete f.source.recurring.lockedUntil;
 res=response();await controller.deleteExpense(request({}),res);assert.equal(res.statusCode,200);assert.equal(deleted,true);
 const child={groupId:a,recurrenceSourceId:sourceId,occurrenceNumber:1};
 mock.method(Expense,'findById',async id=>id===sourceId?f.source:child);
 res=response();await controller.deleteExpense({...request({}),params:{expenseId:b}},res);assert.equal(res.statusCode,409);
});
test('native JPY and KWD totals and all standard split metadata remain unchanged on recurrence',async()=>{
 for(const [currency,amount,parts] of [['JPY',1,[1,0]],['KWD',.003,[.002,.001]]]){
  const f=fixture({amount,splitType:'PERCENTAGE',participants:[{userId:a,amount:parts[0],percentage:50},{userId:b,amount:parts[1],percentage:50}]});
  mock.method(Group,'findById',async()=>({currency}));
  await f.run({now:new Date('2026-02-28')});assert.equal(f.generated.get(1).amount,amount);assert.deepEqual(f.generated.get(1).participants,f.source.participants);
  mock.restoreAll();
 }
});
test('duplicate-key races are accepted only when the exact occurrence exists',async()=>{
 const f=fixture();const write=Expense.updateOne;
 mock.method(Expense,'updateOne',async(filter,update,options)=>{
  if(update.$setOnInsert){await write(filter,update,options);throw Object.assign(Error('duplicate'),{code:11000});}return write(filter,update,options);
 });
 await f.run({now:new Date('2026-02-28')});assert.equal(f.generated.size,1);assert.equal(f.errors.length,0);assert.equal(f.source.recurring.nextNumber,2);
});
