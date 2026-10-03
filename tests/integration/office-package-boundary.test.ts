import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { inspectPptx, renderPptx } from '../../src/pptx/render-pptx.js';
import { parseOfficeXml, unzipOfficeArchive } from '../../src/pptx/office-xml.js';
import { repairPptxGenJsCompatibility } from '../../src/pptx/pptxgenjs-compat.js';
import { loadDefaultTheme, makeMixedDeckFixture } from '../helpers/layout-fixtures.js';
async function fixture() {
  const plan=makeMixedDeckFixture();
  plan.slides=[plan.slides.find(s=>s.layout==='chart')!];plan.imageAssetIds=[];plan.assetManifest=[];
  return unzipSync(await renderPptx(plan,[],loadDefaultTheme()));
}
describe('Office package boundary',()=>{
  it.each(['override','relationship'])('rejects namespace-aliased missing %s targets',async(kind)=>{
    const archive=await fixture();
    const part=kind==='override'?'[Content_Types].xml':'ppt/slides/_rels/slide1.xml.rels';
    const tag=kind==='override'
      ?'<ct:Override xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/ppt/missing.xml" ContentType="application/xml"/>'
      :'<pr:Relationship xmlns:pr="http://schemas.openxmlformats.org/package/2006/relationships" Id="rId999" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/missing.xml"/>';
    archive[part]=strToU8(strFromU8(archive[part]!).replace(/<\/(Types|Relationships)>/u,`${tag}</$1>`));
    await expect(inspectPptx(zipSync(archive))).rejects.toThrow(/missing|Missing/u);
  });
  it.each(['missing-rels','dangling-sheet'])('rejects %s in the embedded chart workbook',async(mode)=>{
    const archive=await fixture();const part=Object.keys(archive).find(n=>n.endsWith('.xlsx'))!;
    const book=unzipSync(archive[part]!);
    if(mode==='missing-rels')delete book['xl/_rels/workbook.xml.rels'];
    else book['xl/workbook.xml']=strToU8(strFromU8(book['xl/workbook.xml']!).replace(/r:id="[^"]+"/u,'r:id="rId999"'));
    archive[part]=zipSync(book);
    await expect(inspectPptx(zipSync(archive))).rejects.toThrow(/relationship|Missing/u);
  });
  it('does not trust a stored entry whose expanded size differs from its ZIP declaration',()=>{
    const archive=zipSync({'large.bin':new Uint8Array(1000)},{level:0});
    const view=new DataView(archive.buffer,archive.byteOffset,archive.byteLength);
    for(let i=0;i<archive.length-28;i++)if(view.getUint32(i,true)===0x02014b50)view.setUint32(i+24,0,true);
    expect(()=>unzipOfficeArchive(archive,'test',10)).toThrow(/size|limit/iu);
  });
  it('rejects duplicate expanded XML attributes even with different prefixes',()=>{
    expect(()=>parseOfficeXml('<r xmlns:q="urn:x" xmlns:s="urn:x" q:a="1" s:a="2"/>','fixture.xml')).toThrow(/duplicate.*attribute/iu);
  });
  it('retains the containing part on a missing Override error',async()=>{
    const archive=await fixture();
    archive['[Content_Types].xml']=strToU8(strFromU8(archive['[Content_Types].xml']!).replace('</Types>','<Override PartName="/ppt/missing.xml" ContentType="application/xml"/></Types>'));
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({partName:'[Content_Types].xml'});
  });
  it('rejects ambiguous connected table IDs with leading-zero references',async()=>{
    const plan=makeMixedDeckFixture();plan.slides=[plan.slides.find(s=>s.layout==='table')!];plan.imageAssetIds=[];plan.assetManifest=[];
    const archive=unzipSync(await renderPptx(plan,[],loadDefaultTheme()));
    const part='ppt/slides/slide1.xml';
    archive[part]=strToU8(strFromU8(archive[part]!).replace(/(<p:nvGraphicFramePr><p:cNvPr id=")[^"]+/u,'$12')
      .replace('</p:nvGraphicFramePr>','<a:stCxn id="002" idx="0"/></p:nvGraphicFramePr>'));
    expect(()=>repairPptxGenJsCompatibility(zipSync(archive))).toThrow(/ambiguous|duplicate/iu);
  });

});
