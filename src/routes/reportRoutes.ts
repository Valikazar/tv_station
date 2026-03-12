import express, { Request, Response } from 'express';
import { getStats, getPlaybackLogStats, FileStats } from '../services/statsService';
import { getSlots } from '../utils/timeSlots';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'path';

const router = express.Router();

router.get('/', (req: Request, res: Response) => {
    // Default to last 7 days? Or just empty.
    // Let's pass today as default if none provided, but frontend handles dates.
    const channelId = req.session.currentChannelId || 1;
    res.render('index', {
        slots: getSlots(channelId),
    });
});

router.get('/report', async (req: Request, res: Response) => {
    try {
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const type = 'playback_log'; // Force playback_log type for the frontend links

        if (!startDate || !endDate) {
            return res.status(400).send('Start date and End date are required');
        }

        const channelId = req.session.currentChannelId || 1;
        const stats = await getPlaybackLogStats(startDate, endDate, channelId);

        res.render('report', {
            startDate,
            endDate,
            stats,
            type,
            slots: getSlots(channelId)
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating report');
    }
});

router.get('/download/xlsx', async (req: Request, res: Response) => {
    try {
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const type = 'playback_log';

        const channelId = req.session.currentChannelId || 1;
        const stats = await getPlaybackLogStats(startDate, endDate, channelId);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Report');

        // Dynamic columns: File Name, Total, In Breaks, then each slot
        const columns = [
            { header: 'Название', key: 'title', width: 40 },
            { header: 'Всего', key: 'total', width: 10 },
            { header: 'В перерывах', key: 'inBreaks', width: 15 }
        ];

        const currentSlots = getSlots(channelId);

        currentSlots.forEach(slot => {
            columns.push({ header: slot.name, key: slot.name, width: 12 });
        });

        worksheet.columns = columns;

        stats.forEach(fileStat => {
            const row: any = {
                title: fileStat.display_name,
                total: fileStat.total,
                inBreaks: fileStat.inBreaks
            };
            currentSlots.forEach(slot => {
                row[slot.name] = fileStat.slots[slot.name] || 0;
            });
            worksheet.addRow(row);
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=report-${startDate}-to-${endDate}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating Excel');
    }
});

router.get('/download/pdf', async (req: Request, res: Response) => {
    try {
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const type = 'playback_log';

        const channelId = req.session.currentChannelId || 1;
        const stats = await getPlaybackLogStats(startDate, endDate, channelId);

        const doc = new PDFDocument({ margin: 30, layout: 'landscape' });

        // Register font
        const fontPath = path.join(__dirname, '../../public/fonts/arial.ttf');
        try {
            doc.font(fontPath);
        } catch (e) {
            console.error('Failed to load font:', e);
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=report-${startDate}-to-${endDate}.pdf`);

        doc.pipe(res);

        doc.fontSize(18).text(`Отчёт о трансляциях: с ${startDate} по ${endDate}`, { align: 'center' });
        doc.moveDown();

        const startX = 30;
        const colTitleWidth = 150;
        const colStatWidth = 40;
        const colSlotWidth = 45;

        let currentX = startX;
        let currentY = doc.y + 10;

        // Headers
        doc.fontSize(9).font(fontPath);

        // Static Headers
        doc.text('Название', currentX, currentY, { width: colTitleWidth });
        currentX += colTitleWidth;

        doc.text('Всего', currentX, currentY, { width: colStatWidth, align: 'center' });
        currentX += colStatWidth;

        doc.text('В пер.', currentX, currentY, { width: colStatWidth, align: 'center' }); // "В перерывах" shortened
        currentX += colStatWidth;

        // Dynamic Slot Headers
        const currentSlots = getSlots(channelId);
        currentSlots.forEach(slot => {
            const timeLabel = `${slot.hour}:${slot.minute.toString().padStart(2, '0')}`;
            doc.text(timeLabel, currentX, currentY, { width: colSlotWidth, align: 'center' });
            currentX += colSlotWidth;
        });

        // Line below header
        currentY += 15;
        doc.lineWidth(1).moveTo(startX, currentY).lineTo(currentX, currentY).stroke();
        currentY += 5;

        // Rows
        doc.fontSize(9);

        stats.forEach((fileStat, index) => {
            // Check page break
            if (currentY > 530) {
                doc.addPage({ margin: 30, layout: 'landscape' });
                doc.font(fontPath);
                currentY = 40;
                // Repeat header? For now, simpler without repeating or simple repeat
                // Let's just carry on, simpler
            }

            // Alternating row background
            if (index % 2 === 0) {
                doc.fillColor('#f9f9f9');
                doc.rect(startX, currentY - 2, currentX - startX, 15).fill();
                doc.fillColor('black');
            }

            let rowX = startX;

            // Title
            let title = fileStat.title;
            if (fileStat.display_name) title = fileStat.display_name;
            // Truncate
            if (title.length > 35) title = title.substring(0, 32) + '...';

            doc.text(title, rowX, currentY, { width: colTitleWidth, ellipsis: true });
            rowX += colTitleWidth;

            // Stats
            doc.text(fileStat.total.toString(), rowX, currentY, { width: colStatWidth, align: 'center' });
            rowX += colStatWidth;

            doc.text(fileStat.inBreaks.toString(), rowX, currentY, { width: colStatWidth, align: 'center' });
            rowX += colStatWidth;

            // Slots
            const currentSlots2 = getSlots(channelId);
            currentSlots2.forEach(slot => {
                const val = fileStat.slots[slot.name] || 0;
                const text = val > 0 ? val.toString() : '-';
                if (val > 0) doc.font(fontPath); // Bolder? No regular is fine
                else doc.fillColor('#cccccc');

                doc.text(text, rowX, currentY, { width: colSlotWidth, align: 'center' });
                doc.fillColor('black'); // Reset color

                rowX += colSlotWidth;
            });

            currentY += 15;
        });

        doc.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating PDF');
    }
});

export default router;
