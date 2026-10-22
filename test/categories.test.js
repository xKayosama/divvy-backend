const {test} = require('node:test');
const assert = require('node:assert/strict');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const {buildCategoryBreakdown} = require('../src/modules/dashboard/dashboard.categories');
const id = '507f1f77bcf86cd799439011';
const expenses = ["COFFEE", "TRAVEL", "ACCOMMODATION", "FUEL", "PARKING", "EDUCATION", "PETS", "GIFTS", "HOME_MAINTENANCE", "PERSONAL_CARE", "FITNESS", "SUBSCRIPTIONS"];
const bills = ["GAS", "ASSOCIATION_DUES", "EDUCATION", "CHILDCARE", "LOAN", "CREDIT_CARD", "PROPERTY_TAX", "MAINTENANCE"];
test('new expense and bill categories validate and serialize without changing old defaults', () => {
 for (const category of expenses) {
  const doc = new Expense({groupId:id,paidBy:id,description:'Example',amount:10,category,participants:[{userId:id,amount:10}]});
  assert.equal(doc.validateSync(),undefined,category);
  assert.equal(doc.toObject().category,category);
 }
 for (const category of bills) {
  const doc = new Bill({groupId:id,name:'Example',amount:10,dueDate:new Date('2026-11-01'),category});
  assert.equal(doc.validateSync(),undefined,category);
  assert.equal(doc.toObject().category,category);
 }
 assert.equal(new Expense().category,'OTHERS');
 assert.equal(new Bill().category,'OTHER');
 assert.ok(new Expense({category:'UNSUPPORTED'}).validateSync().errors.category);
 assert.ok(new Bill({category:'UNSUPPORTED'}).validateSync().errors.category);
});
test('dashboard retains new expense categories instead of grouping them as other',()=>{
 const result=buildCategoryBreakdown(expenses.map(category=>({category,amount:1})),'PHP');
 assert.equal(result.totalAmount,expenses.length);
 assert.deepEqual(result.spendingByCategory.map(item=>item.category).sort(),[...expenses].sort());
});
