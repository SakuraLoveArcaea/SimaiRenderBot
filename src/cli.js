import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SimaiRenderService } from './render.js';

// 用法：
//   node src/cli.js "(150){4}1,2,3,4,E" [輸出.gif]
//   node src/cli.js --file chart.txt [輸出.gif]
async function main() {
    const args = process.argv.slice(2);
    if (!args.length) {
        console.log('用法: node src/cli.js "<simai語法>" [out.gif]\n     node src/cli.js --file chart.txt [out.gif]');
        process.exit(1);
    }

    let simaiText;
    let outArg;
    if (args[0] === '--file') {
        simaiText = await fs.readFile(args[1], 'utf-8');
        outArg = args[2];
    } else {
        simaiText = args[0];
        outArg = args[1];
    }
    const outPath = outArg ?? path.join('out', `render-${Date.now()}.gif`);

    const service = new SimaiRenderService();
    console.time('init');
    await service.init();
    console.timeEnd('init');

    try {
        const info = await service.inspect(simaiText);
        console.log(`譜面長度 ${info.endTime.toFixed(2)}s, BPM ${info.bpm}, notes:`, info.noteCounts);
        if (info.warns?.length) console.warn('警告:', info.warns);

        console.time('render');
        const result = await service.renderGif(simaiText);
        console.timeEnd('render');

        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, result.gif);
        console.log(`完成 → ${outPath} (${(result.gif.length / 1e6).toFixed(2)}MB, 畫質: ${JSON.stringify(result.quality)})`);
    } finally {
        await service.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
