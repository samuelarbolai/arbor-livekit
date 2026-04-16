import asyncio
import json
import os
import logging
from pyclbr import Class
from dotenv import load_dotenv
from livekit import api
from pydantic import BaseModel
from typing import Optional

load_dotenv()

logger = logging.getLogger("make-call")
logger.setLevel(logging.INFO)


class UserDetails(BaseModel):
    user_input: str
    language: Optional[str] = 'en'
    voice_id: Optional[str] = '03496517-369a-4db1-8236-3d3ae459ddf7'
    phone_number: Optional[str] = None


room_name = "my-room"
agent_name = "my-agent"
outbound_trunk_id = os.getenv("SIP_OUTBOUND_TRUNK_ID")

user_input_raw = """

   <user-details>
       Name: "Samuel"
       Language: ""
       Goal: "Never go to bed late. Always got to bed before 11 pm."
       Ritual: "Pray the Psalm 91 every night at 9:30 pm".
       Context: "Despite not yet finding a therapist, Samuel feels confident in his path forward — returning to the nightly practice of praying the Psalm with more discipline, as it has helped him before."
   </user-details>


   <THE STOP>
       <Self-affirmation>
           "No matter what, I must keep and grow my confidence in myself — I am valuable, and my ultimate goal is to self-advocate, just like Jacob wrestling the angel."
       </Self-affirmation>
       <appreciation-of-little-things>
           "I am alive, and I have a problem to solve — that opportunity alone is the source of all goodness, and like Jacob, I will be blessed through it."
       </appreciation-of-little-things>
   </THE STOP>


   <THE CONSCIENCE>
       <benefits-hoping-to-gain>
           I want to give my fullest every day, feel strong and good, complete full weeks of work, and build an unbreakable confidence in my capacity to adapt and change.
       </benefits-hoping-to-gain>
       <what-do-i-want-to-nurture-?>
           I want to nurture my care for my own professional performance and my resilience by consistently showing up and performing well through difficult situations.
       </what-do-i-want-to-nurture-?>
   </THE CONSCIENCE>


   <THE INTENTION>
   </THE INTENTION>


   <THE COMMITMENT>
   </THE COMMITMENT>


   <symbolic help>
       <type>
       </type>
       <tradition>
       </tradition>
       <symbolic invocation>
       </symbolic invocation>
       Judaism. The myth of Jacob, especially.
       The Lord of The Rings. The metaphors related to real life, temptation, goodness, and resilience. Deep admiration for Tolkien and how the hardships in his life and academic knowledge of culture shaped the wonderful metaphors in the lord of the rings tale.
   </symbolic help>


   <social help>
   </social help>


"""

payload = UserDetails(user_input=user_input_raw, language='en', voice_id='03496517-369a-4db1-8236-3d3ae459ddf7', phone_number="+573168248411")

async def make_call(payload: UserDetails):

    user_input = payload.user_input
    language = payload.language
    voice_id = payload.voice_id
    phone_number = payload.phone_number

    """Create a dispatch and add a SIP participant to call the phone number"""
    lkapi = api.LiveKitAPI()
    print(f"Connecting to LiveKit at {os.getenv('LIVEKIT_URL')}")

    logger.info(f"Creating dispatch for agent {agent_name} in room {room_name}")

    metadata_contents = {
                "phone_number": phone_number,
                "user_input": user_input,
                "language": language,
                "voice_id": voice_id
            }

    dispatch = await lkapi.agent_dispatch.create_dispatch(
        api.CreateAgentDispatchRequest( agent_name=agent_name, room=room_name, metadata= json.dumps(metadata_contents)
        )
    )

    print(f"Created dispatch: {dispatch}")
    logger.info(f"Created dispatch: {dispatch}")

    if not outbound_trunk_id or not outbound_trunk_id.startswith("ST_"):
        logger.error("SIP_OUTBOUND_TRUNK_ID is not set or invalid")
        return

    logger.info(f"Dialing {phone_number} to room {room_name}")
    print(f"Dialing {phone_number} to room {room_name}")

    try:
        sip_participant = await lkapi.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                room_name=room_name,
                sip_trunk_id=outbound_trunk_id,
                sip_call_to=phone_number,
                participant_identity="phone_user",
            )
        )
        logger.info(f"Created SIP participant: {sip_participant}")
        print(f"Created SIP participant: {sip_participant}")
    except Exception as e:
        logger.error(f"Error creating SIP participant: {e}")
        print(f"Error creating SIP participant: {e}")

    await lkapi.aclose()

async def main():
    await make_call(payload)

if __name__ == "__main__":
    asyncio.run(main())