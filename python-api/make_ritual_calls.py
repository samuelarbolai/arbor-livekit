

async def make_ritual_calls(phone_numbers: array):

    rituals = ritualsList.Ritual()
    report = {
        succesful: 0,
        unsuccesful : 0
    }

    for each ritual in rituals:
        try:
            phone_number = ritual.User().phone_number
            make_call(phone_number)
            report.succesful += 1
        catch:
            report.unsuccseful += 1
            Exception
    
    return report
    