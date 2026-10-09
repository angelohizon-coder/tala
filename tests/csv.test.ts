import { describe, expect, it } from 'vitest';
import { statementAmount, statementDate, supportsStatementAccount } from '../src/db/csv';
describe('statement boundaries',()=>{
  it('requires unambiguous decimal and grouped amounts',()=>{expect(statementAmount('-1,234.50')).toBe(-1234.5);expect(statementAmount(' 0.25 ')).toBe(.25);for(const bad of ['1,23','1234,567','1,000,','1.000,25','','Infinity','₱100','1e6','NaN'])expect(()=>statementAmount(bad)).toThrow();});
  it('requires the selected date convention and an actual calendar date',()=>{expect(statementDate('09/10/2026','DMY','2026-10-09')).toBe('2026-10-09');expect(statementDate('10/09/2026','MDY','2026-10-09')).toBe('2026-10-09');for(const raw of ['2026-02-30','2026-10-10','2026-1-1','09/10/2026'])expect(()=>statementDate(raw,'ISO','2026-10-09')).toThrow();});
  it('does not infer card and loan credits as income',()=>{expect(supportsStatementAccount('CHECKING')).toBe(true);expect(supportsStatementAccount('SAVINGS')).toBe(true);for(const type of ['CREDIT_CARD','PERSONAL_LOAN','MORTGAGE','OTHER_LIABILITY'])expect(supportsStatementAccount(type)).toBe(false);});
});
