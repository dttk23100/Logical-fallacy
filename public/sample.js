// A ready-made conversation with its analysis already done, so the sample opens instantly.
// Generated once by running these lines through the analyzer.
export const SAMPLE = {
  "segments": [
    {
      "id": "s1",
      "text": "So I looked at the plan you sent over and I think the price is a bit high for us.",
      "speaker": "A",
      "at": 0
    },
    {
      "id": "s2",
      "text": "Honestly, everyone in your industry has already signed up, so you'd be the only one left behind.",
      "speaker": "B",
      "at": 6000
    },
    {
      "id": "s3",
      "text": "And this price is only valid until tonight, after that I can't guarantee anything.",
      "speaker": "B",
      "at": 12000
    },
    {
      "id": "s4",
      "text": "Studies show that companies using this grow three hundred percent faster.",
      "speaker": "B",
      "at": 18000
    },
    {
      "id": "s5",
      "text": "Well, you would say that, you have never run a business in your life.",
      "speaker": "B",
      "at": 24000
    },
    {
      "id": "s6",
      "text": "So you are saying we should just never spend money on anything?",
      "speaker": "B",
      "at": 30000
    },
    {
      "id": "s7",
      "text": "Can you send me the contract so I can read it over the weekend?",
      "speaker": "A",
      "at": 36000
    }
  ],
  "flags": [
    {
      "segment_id": "s2",
      "quote": "everyone in your industry has already signed up",
      "category": "fallacy",
      "name": "Argumentum ad populum (bandwagon)",
      "explanation": "Others signing up says nothing about whether the deal suits you.",
      "confidence": "high",
      "id": "f1"
    },
    {
      "segment_id": "s3",
      "quote": "this price is only valid until tonight",
      "category": "pressure_tactic",
      "name": "False urgency",
      "explanation": "An arbitrary deadline pushes a decision before proper evaluation.",
      "confidence": "high",
      "id": "f2"
    },
    {
      "segment_id": "s4",
      "quote": "Studies show that companies using this grow three hundred percent faster",
      "category": "statistical_red_flag",
      "name": "Unsourced statistic",
      "explanation": "No study named, no baseline; ask which study and compared to what.",
      "confidence": "high",
      "id": "f3"
    },
    {
      "segment_id": "s4",
      "quote": "companies using this grow three hundred percent faster",
      "category": "statistical_red_flag",
      "name": "Correlation-causation fallacy",
      "explanation": "Faster-growing companies may simply adopt such tools; causation isn't shown.",
      "confidence": "medium",
      "id": "f4"
    },
    {
      "segment_id": "s5",
      "quote": "you have never run a business in your life",
      "category": "fallacy",
      "name": "Ad hominem",
      "explanation": "Attacks the speaker's background instead of the claim itself.",
      "confidence": "high",
      "id": "f5"
    },
    {
      "segment_id": "s6",
      "quote": "So you are saying we should just never spend money on anything?",
      "category": "fallacy",
      "name": "Straw man",
      "explanation": "Distorts a concern about price into refusing all spending.",
      "confidence": "high",
      "id": "f6"
    }
  ]
};
