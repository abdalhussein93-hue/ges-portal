'use strict';
/** Small made-up data for tests (no real people). */

function campDoc() {
  const bed = (status = 'vacant', name = '') => ({ status, name, badge: '', company: '', notes: '', food: '' });
  return {
    campData: {
      A: { rooms: { 'A-1': { number: 'A-1', category: 'Senior', capacity: 2, beds: [bed(), bed('occupied', 'Test Resident')] }, 'A-2': { number: 'A-2', category: 'Worker', capacity: 1, beds: [bed()] } } },
      B: { rooms: { 'B-1': { number: 'B-1', category: 'Junior', capacity: 1, beds: [bed()] } } },
      _profit: { 'Global Village': { rates: { Senior_1: 50 }, items: [], entries: [] } },
    },
    historyLog: [{ id: 'h2', action: 'Check In', name: 'Test Resident', block: 'A', room: 'A-1' }, { id: 'h1', action: 'Check Out', name: 'Old Resident' }],
    companies: ['ALPHA CO', 'BETA CO'],
    nationalities: ['India', 'Nepal'],
    BLOCKS_META: { A: { name: 'Block A', defaultCap: 2 }, B: { name: 'Block B', defaultCap: 1 } },
    foodCategories: ['Senior', 'Worker'],
    campList: ['Global Village'],
    appSeeds: ['alfarah_v1'],
    // most tests check direct Operator changes; approval tests switch this on
    approvalCfg: { enabled: false },
  };
}

function manpowerDesktopFile() {
  return {
    app: 'GES Manpower System',
    saved: '2026-11-15T10:00:00.000Z',
    data: {
      gesStaffV4: JSON.stringify([
        { id: 1, empNo: '1001', name: 'Test Staff One', dept: 'Kitchen', status: 'Active', history: [] },
        { id: 2, empNo: '1002', name: 'Test Staff Two', dept: 'Laundry', status: 'Active', history: [] },
      ]),
      gesCampName: 'GES CAMP',
      gesSettings: JSON.stringify({ notice: 30 }),
      gesSeedVersion: '2026-07-11',
    },
  };
}

function costingDoc() {
  return {
    v: 1,
    items: [{ id: 'i0', ref: '001', desc: 'APPLE', pack: 'KG', cost: 5, cat: 'FRUIT', limit: 0, limitPer: 'day', prices: { '2026-11': 5 } }],
    categories: ['FRUIT'],
    groups: [{ id: 'g_sen', name: 'Senior' }],
    costCenters: [{ id: 'cc_senior', name: 'Senior', target: 16.9, camp: true, base: 'own' }],
    targets: { g_sen: 16.9 },
    settings: { currency: 'AED', lowStock: 10 },
    months: { '2026-11': { opening: { i0: 10 }, received: {}, cons: {}, manday: {} } },
    priceChanges: [],
  };
}

module.exports = { campDoc, manpowerDesktopFile, costingDoc };
