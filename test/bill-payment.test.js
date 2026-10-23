const {test,afterEach,mock}=require('node:test');
const assert=require('node:assert/strict');
const Bill=require('../src/modules/bills/Bill');
const Expense=require('../src/modules/expenses/Expense');
const Member=require('../src/modules/groups/GroupMember');
const Group=require('../src/modules/groups/Group');
const {payBill,recoverBillPayments,startBillPaymentWorker}=require('../src/modules/bills/bill.payment');
const billController=require('../src/modules/bills/bill.controller');
const expenseController=require('../src/modules/expenses/expense.controller');
const a='507f1f77bcf86cd799439011',b='507f1f77bcf86cd799439012',bid='507f1f77bcf86cd799439013';
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const req=body=>({params:{billId:bid,id:a},user:{_id:a},group:{currency:'PHP'},body,query:{}});
const body=()=>({paidBy:a,splitType:'EQUAL',participants:[{userId:a},{userId:b}]});
function query(value){return {select(){return this;},populate(){return this;},sort(){return this;},cursor:async function*(){for(const item of Array.isArray(value)?value:[value])yield item;},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}};}
afterEach(()=>mock.restoreAll());
function fixture({currency='PHP',amount=100}={}){
 const bill={_id:bid,groupId:a,name:'Power',amount,category:'ELECTRICITY',notes:'Account',dueDate:new Date('2026-10-01'),updatedAt:new Date('2026-10-01'),status:'PENDING',expenseId:null,async populate(){}};
 const expenses=new Map();
 mock.method(Bill,'findById',()=>query(bill));
 mock.method(Bill,'find',()=>query(bill.expenseId&&bill.status!=='PAID'?[bill]:[]));
 mock.method(Member,'findOne',async()=>({}));
 mock.method(Member,'find',()=>query([{userId:a},{userId:b}]));
 mock.method(Group,'findById',async()=>({currency}));
 mock.method(Bill,'findOneAndUpdate',(filter,update)=>{
  const match=(!filter.status || filter.status.$ne!==bill.status) && (filter.expenseId===undefined || (filter.expenseId===null?bill.expenseId==null:String(filter.expenseId)===String(bill.expenseId)));
  if(!match)return query(null);
  Object.assign(bill,update.$set);return query(bill);
 });
 mock.method(Expense,'findOneAndUpdate',async(filter,update)=>{if(!expenses.has(String(filter.billId)))expenses.set(String(filter.billId),new Expense(update.$setOnInsert));return expenses.get(String(filter.billId));});
 mock.method(Expense,'findOne',async filter=>expenses.get(String(filter.billId))??null);
 return {bill,expenses,pay:async payload=>{const res=response();await payBill(req(payload??body()),res);return res;}};
}
test('paying a bill creates exactly one linked expense and preserves the server payment date',async()=>{
 const f=fixture();const result=await f.pay();assert.equal(result.statusCode,200);
 assert.equal(f.bill.status,'PAID');assert.equal(f.expenses.size,1);
 const expense=f.expenses.get(bid);assert.equal(String(expense.billId),bid);assert.equal(String(f.bill.expenseId),String(expense._id));
 assert.equal(String(expense.paidBy),a);assert.equal(expense.amount,100);assert.equal(expense.category,'UTILITIES');
 assert.deepEqual(expense.participants.map(p=>p.amount),[50,50]);assert.equal(expense.date.toISOString(),f.bill.paidAt.toISOString());
 assert.equal(result.body.data.bill.payment,undefined);assert.equal(result.body.data.bill.paymentPending,false);
 const timestamp=f.bill.paidAt.toISOString();assert.equal((await f.pay()).statusCode,200);assert.equal(f.expenses.size,1);assert.equal(f.bill.paidAt.toISOString(),timestamp);
});
test('exact, percentage and share payment settings calculate native precision on the server',async()=>{
 for(const [splitType,participants,expected] of [
  ['EXACT',[{userId:a,amount:60},{userId:b,amount:40}],[60,40]],
  ['PERCENTAGE',[{userId:a,percentage:25},{userId:b,percentage:75}],[25,75]],
  ['SHARES',[{userId:a,shares:2},{userId:b,shares:1}],[66.67,33.33]]
 ]){const f=fixture();const res=await f.pay({paidBy:a,splitType,participants});assert.equal(res.statusCode,200);assert.deepEqual(f.expenses.get(bid).participants.map(p=>p.amount),expected);mock.restoreAll();}
 for(const [currency,amount,expected] of [['JPY',1,[1,0]],['KWD',.003,[.002,.001]]]){const f=fixture({currency,amount});assert.equal((await f.pay({paidBy:a,splitType:'SHARES',participants:[{userId:a,shares:2},{userId:b,shares:1}]})).statusCode,200);assert.deepEqual(f.expenses.get(bid).participants.map(p=>p.amount),expected);mock.restoreAll();}
});
test('concurrent identical confirmations and conflicting payer selections cannot double-charge',async()=>{
 const f=fixture();const results=await Promise.all([f.pay(),f.pay()]);assert.ok(results.every(res=>res.statusCode===200));assert.equal(f.expenses.size,1);
 assert.equal((await f.pay({...body(),paidBy:b})).statusCode,409);assert.equal(f.expenses.size,1);assert.equal(String(f.expenses.get(bid).paidBy),a);
});
test('interrupted expense insert leaves a recoverable frozen reservation without falsely paying the bill',async()=>{
 const f=fixture();const write=Expense.findOneAndUpdate;let fail=true;
 mock.method(Expense,'findOneAndUpdate',async(...args)=>{if(fail){fail=false;throw Error('database interruption');}return write(...args);});
 let res=await f.pay();assert.equal(res.statusCode,503);assert.equal(f.bill.status,'PENDING');assert.ok(f.bill.expenseId);assert.equal(f.expenses.size,0);
 const reserved=f.bill.expenseId;
 res=await f.pay({resume:true});assert.equal(res.statusCode,200);assert.equal(f.expenses.size,1);assert.equal(String(f.bill.expenseId),String(reserved));
});
test('recovery after expense insert but before paid checkpoint reuses the same expense',async()=>{
 const f=fixture();const write=Bill.findOneAndUpdate;let fail=true;
 mock.method(Bill,'findOneAndUpdate',(filter,update)=>{if(update.$set.status==='PAID'&&fail){fail=false;throw Error('checkpoint interrupted');}return write(filter,update);});
 assert.equal((await f.pay()).statusCode,503);assert.equal(f.expenses.size,1);assert.equal(f.bill.status,'PENDING');
 await recoverBillPayments({onError:()=>assert.fail('recovery should succeed')});assert.equal(f.bill.status,'PAID');assert.equal(f.expenses.size,1);
 assert.equal((await f.pay({resume:true})).statusCode,200);assert.equal(f.expenses.size,1);
});
test('invalid or inactive participants and unauthorized users cause no reservation or expense write',async()=>{
 const f=fixture();
 for(const payload of [{paidBy:a},{...body(),participants:[]},{...body(),participants:[{userId:a},{userId:a}]},{...body(),splitType:'ITEMIZED'},{...body(),amount:1000},{paidBy:a,splitType:'EXACT',participants:[{userId:a,amount:2}]},{paidBy:a,splitType:'SHARES',participants:[{userId:a,shares:0}]}])assert.equal((await f.pay(payload)).statusCode,400);
 mock.method(Member,'find',()=>query([{userId:a}]));assert.equal((await f.pay()).statusCode,400);
 mock.method(Member,'findOne',async()=>null);assert.equal((await f.pay()).statusCode,403);
 assert.equal(f.bill.expenseId,null);assert.equal(f.expenses.size,0);
});
test('reserved bills and linked expenses cannot be edited or deleted independently',async()=>{
 const f=fixture();await f.pay();
 for(const action of ['updateExpense','deleteExpense']){
  mock.method(Expense,'findById',async()=>f.expenses.get(bid));const res=response();await expenseController[action]({...req({description:'Change'}),params:{expenseId:String(f.bill.expenseId)}},res);assert.equal(res.statusCode,409);
 }
 f.bill.status='PENDING';
 for(const action of ['updateBill','deleteBill']){const res=response();await billController[action](req({name:'Change'}),res);assert.equal(res.statusCode,409);}
});
test('legacy paid bills are not backfilled, and creating directly paid bills cannot bypass split confirmation',async()=>{
 const f=fixture();f.bill.status='PAID';assert.equal((await f.pay()).statusCode,409);assert.equal(f.expenses.size,0);
 const res=response();await billController.createBill(req({name:'Bill',amount:100,dueDate:'2026-10-31',status:'PAID',paidBy:a}),res);assert.equal(res.statusCode,400);
});
test('paid bill amounts affect balances, dashboard spending and settlement suggestions through the expense exactly once',async()=>{
 const f=fixture();await f.pay();await f.pay();
 const Settlement=require('../src/modules/settlements/Settlement');
 mock.method(Settlement,'find',()=>query([]));
 mock.method(Member,'find',()=>query([{userId:{_id:a}},{userId:{_id:b}}]));
 mock.method(Expense,'find',()=>query([...f.expenses.values()]));mock.method(Bill,'find',()=>query([f.bill]));
 const {getGroupBalances}=require('../src/modules/balances/balance.controller');
 const {getGroupDashboard}=require('../src/modules/dashboard/dashboard.controller');
 const {getGroupSettlements}=require('../src/modules/settlements/settlement.controller');
 let res=response();await getGroupBalances(req({}),res);assert.equal(res.statusCode,200);assert.equal(res.body.data.totalExpenses,100);assert.deepEqual(res.body.data.members.map(member=>member.net),[50,-50]);
 res=response();await getGroupDashboard(req({}),res);assert.equal(res.statusCode,200);assert.equal(res.body.data.summary.totalExpenses,100);assert.equal(res.body.data.summary.totalPaid,100);assert.equal(res.body.data.bills.paidAmount,100);
 res=response();await getGroupSettlements(req({}),res);assert.equal(res.statusCode,200);assert.equal(res.body.data.settlements[0].amount,50);
});
test('the unique partial bill link index is installed before the recovery worker starts',async()=>{
 assert.ok(Expense.schema.indexes().some(([fields,options])=>fields.billId===1&&options.unique&&options.partialFilterExpression));
 mock.method(Expense,'createIndexes',async()=>{throw Error('index unavailable');});await assert.rejects(startBillPaymentWorker(),/index unavailable/);
});

test('client-supplied payment dates are ignored and duplicate-key races reuse the exact saved link',async()=>{
 const f=fixture();const write=Expense.findOneAndUpdate;let race=true;
 mock.method(Expense,'findOneAndUpdate',async(...args)=>{const expense=await write(...args);if(race){race=false;throw Object.assign(Error('duplicate'),{code:11000});}return expense;});
 const result=await f.pay({...body(),paidAt:'2000-01-01'});assert.equal(result.statusCode,200);assert.notEqual(f.bill.paidAt.getUTCFullYear(),2000);assert.equal(f.expenses.size,1);
});
test('a concurrently changed bill cannot reserve a stale payment snapshot',async()=>{
 const f=fixture();mock.method(Bill,'findOneAndUpdate',()=>query(null));
 const result=await f.pay();assert.equal(result.statusCode,409);assert.equal(f.bill.expenseId,null);assert.equal(f.expenses.size,0);
});

test('soft-deleted groups cannot receive payments or recover pending payment reservations',async()=>{
 const f=fixture();mock.method(Expense,'findOneAndUpdate',async()=>{throw Error('interrupted insert');});
 assert.equal((await f.pay()).statusCode,503);assert.equal(f.expenses.size,0);
 mock.method(Group,'findById',async()=>({currency:'PHP',deletedAt:new Date()}));
 await recoverBillPayments();assert.equal(f.bill.status,'PENDING');assert.equal(f.expenses.size,0);
 assert.equal((await f.pay({resume:true})).statusCode,404);
});
